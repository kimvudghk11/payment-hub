import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { verifyPaymentHubWebhook } from '../../examples/webhook-signature-verify';
import { WebhookDelivery } from '../../src/outbox/domain/webhook-delivery.entity';
import { WebhookDispatcher } from '../../src/outbox/webhook-dispatcher';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss } from '../support/fake-toss';
import { FakeWebhookReceiver } from '../support/fake-webhook-receiver';
import { IntegrationApp, createIntegrationApp, dataOf } from '../support/integration-app';

interface DeliveryRow {
  id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date;
  last_http_status: number | null;
  last_error: string | null;
  delivered_at: Date | null;
}

let seq = 0;

describe('웹훅 발송 워커 — outbox → 서비스 webhookUrl', () => {
  const toss = new FakeToss();
  const receiver = new FakeWebhookReceiver();
  let ctx: IntegrationApp;
  let dispatcher: WebhookDispatcher;
  let service: PayableService;

  /** 결제 승인 → PAYMENT_CONFIRMED 이벤트 + 전달 대상 PENDING */
  const confirmPayment = async (target: PayableService = service): Promise<string> => {
    const auth = { Authorization: `Bearer ${target.apiKey}` };
    const order = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth)
      .send({
        externalOrderId: `wh-order-${Date.now()}-${seq++}`,
        externalUserId: 'user-1',
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 30000, quantity: 1 }],
        totalAmount: 30000,
      });
    const { orderId } = dataOf<{ orderId: string }>(order);
    const res = await ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(auth)
      .send({ orderId, paymentKey: `tgen_wh_${seq++}`, amount: 30000 });
    return dataOf<{ paymentId: string }>(res).paymentId;
  };

  const deliveryOf = async (paymentId: string): Promise<DeliveryRow> =>
    (
      await ctx.dataSource.query<DeliveryRow[]>(
        `SELECT d.* FROM tb_webhook_delivery d JOIN tb_outbox_event e ON e.id = d.event_id WHERE e.aggregate_id = $1`,
        [paymentId],
      )
    )[0];

  /** 다른 테스트가 남긴 대기 건이 섞이지 않게 이번 테스트 건만 due로 둔다 */
  const onlyDue = (paymentId: string) =>
    ctx.dataSource.query(
      `UPDATE tb_webhook_delivery d SET next_attempt_at = now() + interval '1 day'
        WHERE d.status IN ('PENDING', 'RETRYING')
          AND d.event_id NOT IN (SELECT id FROM tb_outbox_event WHERE aggregate_id = $1)`,
      [paymentId],
    );

  beforeAll(async () => {
    const webhookUrl = await receiver.start();
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), WEBHOOK_TIMEOUT_MS: '500' });
    dispatcher = ctx.app.get(WebhookDispatcher);
    service = await onboardPayableService(ctx, { webhookUrl });
  });
  afterEach(() => receiver.reset());
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
    await receiver.close();
  });

  it('서명한 요청을 보내고 SUCCEEDED로 기록한다 — 서비스는 가이드의 검증 코드로 확인할 수 있다', async () => {
    const paymentId = await confirmPayment();
    await onlyDue(paymentId);

    const result = await dispatcher.dispatchDue();

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    const [request] = receiver.received;
    const verified = verifyPaymentHubWebhook({
      secret: service.webhookSecret,
      headers: request.headers,
      rawBody: request.rawBody,
    });
    expect(verified).toMatchObject({ ok: true });
    expect(request.headers['content-type']).toContain('application/json');

    const body = JSON.parse(request.rawBody) as Record<string, unknown>;
    expect(body).toMatchObject({
      eventType: 'PAYMENT_CONFIRMED',
      data: { paymentId, status: 'DONE', amount: 30000, externalUserId: 'user-1' },
    });
    expect(verified.ok && verified.eventId).toBe(body.eventId);

    expect(await deliveryOf(paymentId)).toMatchObject({
      status: 'SUCCEEDED',
      attempt_count: 1,
      last_http_status: 200,
      last_error: null,
    });
  });

  it('서비스가 2xx가 아니면 RETRYING — 1분 뒤에 다시 보내고, 그 전에는 보내지 않는다', async () => {
    const paymentId = await confirmPayment();
    await onlyDue(paymentId);
    receiver.status = 500;

    const before = Date.now();
    await dispatcher.dispatchDue();
    const failed = await deliveryOf(paymentId);
    expect(failed).toMatchObject({ status: 'RETRYING', attempt_count: 1, last_http_status: 500 });
    expect(failed.last_error).toContain('500');
    expect(new Date(failed.next_attempt_at).getTime() - before).toBeGreaterThanOrEqual(59_000);

    receiver.status = 200;
    expect(await dispatcher.dispatchDue()).toMatchObject({ claimed: 0 });

    await dispatcher.dispatchDue(new Date(Date.now() + 61_000));
    expect(await deliveryOf(paymentId)).toMatchObject({ status: 'SUCCEEDED', attempt_count: 2 });
    expect(receiver.received).toHaveLength(2);
    // 재시도도 같은 이벤트 ID — 서비스는 이 값으로 중복을 거른다
    expect(receiver.received[0].headers['x-paymenthub-event-id']).toBe(
      receiver.received[1].headers['x-paymenthub-event-id'],
    );
  });

  it('연결 실패·응답 지연도 실패로 기록하고 재시도한다', async () => {
    const paymentId = await confirmPayment();
    await onlyDue(paymentId);
    await ctx.dataSource.query(`UPDATE tb_webhook_delivery SET target_url = 'http://127.0.0.1:1/hook' WHERE id = $1`, [
      (await deliveryOf(paymentId)).id,
    ]);

    await dispatcher.dispatchDue();

    expect(await deliveryOf(paymentId)).toMatchObject({ status: 'RETRYING', last_http_status: null });
  });

  it('전송 중 워커가 죽어 임대가 만료된 PROCESSING 건은 다시 가져가 보낸다', async () => {
    const paymentId = await confirmPayment();
    await onlyDue(paymentId);
    await ctx.dataSource.query(
      `UPDATE tb_webhook_delivery
          SET status = 'PROCESSING', attempt_count = 1,
              locked_until = now() - interval '1 second', next_attempt_at = now() - interval '1 second'
        WHERE id = $1`,
      [(await deliveryOf(paymentId)).id],
    );

    await dispatcher.dispatchDue();

    expect(await deliveryOf(paymentId)).toMatchObject({ status: 'SUCCEEDED', attempt_count: 2 });
  });

  it('워커 두 개가 동시에 돌아도 한 건은 한 번만 보낸다 (행 잠금으로 획득)', async () => {
    const paymentId = await confirmPayment();
    await onlyDue(paymentId);
    // 획득 트랜잭션 안의 저장을 늦춰 두 워커의 획득 구간을 겹치게 만든다
    const deliveries = ctx.app.get<Repository<WebhookDelivery>>(getRepositoryToken(WebhookDelivery));
    const original = deliveries.save.bind(deliveries) as (entity: WebhookDelivery) => Promise<WebhookDelivery>;
    const spy = jest.spyOn(deliveries, 'save').mockImplementation((async (entity: WebhookDelivery) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return original(entity);
    }) as never);
    try {
      await Promise.all([dispatcher.dispatchDue(), dispatcher.dispatchDue()]);
    } finally {
      spy.mockRestore();
    }

    expect(receiver.received).toHaveLength(1);
    expect(await deliveryOf(paymentId)).toMatchObject({ status: 'SUCCEEDED', attempt_count: 1 });
  });

  // 이 서비스의 서명 키를 지우므로 마지막에 둔다
  it('webhookSecret이 없는 서비스는 서명할 수 없으므로 보내지 않고 실패로 남긴다', async () => {
    const paymentId = await confirmPayment();
    await onlyDue(paymentId);
    await ctx.dataSource.query(
      'UPDATE tb_service SET webhook_secret_enc = NULL, webhook_secret_key_id = NULL WHERE id = $1',
      [service.serviceId],
    );
    await dispatcher.dispatchDue();

    expect(receiver.received).toHaveLength(0);
    expect(await deliveryOf(paymentId)).toMatchObject({ status: 'RETRYING', last_http_status: null });
    expect((await deliveryOf(paymentId)).last_error).toContain('서명 키');
  });
});
