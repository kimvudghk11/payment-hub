import { OutboxService } from '../../src/outbox/outbox.service';
import { OrderExpirer } from '../../src/order/order-expirer';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss, approvedCardPayment } from '../support/fake-toss';
import { IntegrationApp, createIntegrationApp, dataOf } from '../support/integration-app';

let seq = 0;

describe('주문 만료 배치', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let expirer: OrderExpirer;
  let service: PayableService;

  const auth = () => ({ Authorization: `Bearer ${service.apiKey}` });
  const createOrder = async (): Promise<string> => {
    const res = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth())
      .send({
        externalOrderId: `exp-order-${Date.now()}-${seq++}`,
        externalUserId: 'user-1',
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 30000, quantity: 1 }],
        totalAmount: 30000,
      });
    return dataOf<{ orderId: string }>(res).orderId;
  };
  const confirm = (orderId: string) =>
    ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(auth())
      .send({ orderId, paymentKey: `tgen_exp_${seq++}`, amount: 30000 });
  const pastDue = (orderId: string) =>
    ctx.dataSource.query(`UPDATE tb_order SET expires_at = now() - interval '1 minute' WHERE id = $1`, [orderId]);
  const statusOf = async (orderId: string) =>
    (await ctx.dataSource.query<{ status: string }[]>('SELECT status FROM tb_order WHERE id = $1', [orderId]))[0]
      .status;
  const eventsOf = (orderId: string) =>
    ctx.dataSource.query<{ event_type: string; payload: Record<string, unknown> }[]>(
      'SELECT event_type, payload FROM tb_outbox_event WHERE aggregate_id = $1',
      [orderId],
    );

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), TOSS_API_TIMEOUT_MS: '300' });
    expirer = ctx.app.get(OrderExpirer);
    service = await onboardPayableService(ctx);
  });
  afterEach(() => toss.reset());
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  it('결제 없이 만료 시각이 지난 주문 → EXPIRED + ORDER_EXPIRED 이벤트(웹훅 전달 대상 포함)', async () => {
    const orderId = await createOrder();
    await pastDue(orderId);

    await expirer.expireDue();

    expect(await statusOf(orderId)).toBe('EXPIRED');
    const events = await eventsOf(orderId);
    expect(events).toEqual([
      expect.objectContaining({
        event_type: 'ORDER_EXPIRED',
        payload: expect.objectContaining({ orderId }) as unknown,
      }),
    ]);
    const deliveries = await ctx.dataSource.query<unknown[]>(
      `SELECT 1 FROM tb_webhook_delivery d JOIN tb_outbox_event e ON e.id = d.event_id WHERE e.aggregate_id = $1`,
      [orderId],
    );
    expect(deliveries).toHaveLength(1);
  });

  it('실패한 결제 시도만 있는 주문도 만료한다', async () => {
    const orderId = await createOrder();
    toss.respond(() => ({ status: 403, body: { code: 'REJECT_CARD_PAYMENT', message: '거절' } }));
    await confirm(orderId);
    await pastDue(orderId);

    await expirer.expireDue();

    expect(await statusOf(orderId)).toBe('EXPIRED');
  });

  it('입금 대기(가상계좌) 결제가 있으면 만료하지 않는다 — 입금이 아직 올 수 있다', async () => {
    const orderId = await createOrder();
    toss.respond((request) => ({
      status: 200,
      body: approvedCardPayment(request, {
        status: 'WAITING_FOR_DEPOSIT',
        method: '가상계좌',
        approvedAt: null,
        card: null,
        virtualAccount: { accountNumber: 'X1', bankCode: '20', dueDate: '2026-12-31T23:59:59+09:00' },
      }),
    }));
    await confirm(orderId);
    await pastDue(orderId);

    await expirer.expireDue();

    expect(await statusOf(orderId)).toBe('PENDING');
    expect(await eventsOf(orderId)).toEqual([]);
  });

  it('결과 불명(UNKNOWN) 결제가 있으면 만료하지 않는다 — 대사가 먼저 확정해야 한다', async () => {
    const orderId = await createOrder();
    toss.respond((request) => ({ status: 200, body: approvedCardPayment(request), delayMs: 1000 }));
    await confirm(orderId);
    await pastDue(orderId);

    await expirer.expireDue();

    expect(await statusOf(orderId)).toBe('PENDING');
  });

  it('만료 시각 전 주문은 건드리지 않고, 두 번 돌려도 이벤트는 한 번', async () => {
    const fresh = await createOrder();
    const due = await createOrder();
    await pastDue(due);

    await expirer.expireDue();
    await expirer.expireDue();

    expect(await statusOf(fresh)).toBe('PENDING');
    expect(await eventsOf(due)).toHaveLength(1);
  });

  it('한 주문의 만료 처리가 실패해도 나머지는 만료하고, 실패한 주문은 롤백되어 다음 배치에서 다시 시도된다', async () => {
    const failing = await createOrder();
    const ok = await createOrder();
    await pastDue(failing);
    await pastDue(ok);
    await ctx.dataSource.query(`UPDATE tb_order SET expires_at = now() - interval '2 minute' WHERE id = $1`, [failing]);
    const outbox = ctx.app.get(OutboxService);
    const spy = jest.spyOn(outbox, 'publishOrderEvent').mockRejectedValueOnce(new Error('outbox down'));
    try {
      const result = await expirer.expireDue();
      expect(result.failed).toBe(1);
    } finally {
      spy.mockRestore();
    }

    expect(await statusOf(failing)).toBe('PENDING');
    expect(await statusOf(ok)).toBe('EXPIRED');
    await expirer.expireDue();
    expect(await statusOf(failing)).toBe('EXPIRED');
  });

  it('만료 후 주문 조회에 EXPIRED가 보이고 승인은 409 ORDER_EXPIRED', async () => {
    const orderId = await createOrder();
    await pastDue(orderId);
    await expirer.expireDue();

    const order = await ctx.http().get(`/api/v1/orders/${orderId}`).set(auth());
    const res = await confirm(orderId);

    expect(dataOf<{ status: string }>(order).status).toBe('EXPIRED');
    expect(res.status).toBe(409);
  });
});
