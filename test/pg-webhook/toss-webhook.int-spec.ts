import { PaymentReconciler } from '../../src/payment/payment-reconciler';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss, FakeTossResponse, approvedCardPayment } from '../support/fake-toss';
import { IntegrationApp, createIntegrationApp, dataOf } from '../support/integration-app';

let seq = 0;

describe('토스 → hub 웹훅 POST /pg-webhooks/toss (가상계좌 입금)', () => {
  const toss = new FakeToss();
  /** paymentKey별 토스 조회(GET) 응답 */
  const tossState = new Map<string, FakeTossResponse>();
  let ctx: IntegrationApp;
  let service: PayableService;

  const virtualAccount = { accountNumber: 'X6505636518308', bankCode: '20', dueDate: '2026-12-31T23:59:59+09:00' };

  /** 가상계좌 발급 → WAITING_FOR_DEPOSIT */
  const waitingPayment = async () => {
    const auth = { Authorization: `Bearer ${service.apiKey}` };
    const order = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth)
      .send({
        externalOrderId: `va-${Date.now()}-${seq++}`,
        externalUserId: 'user-1',
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 30000, quantity: 1 }],
        totalAmount: 30000,
      });
    const { orderId } = dataOf<{ orderId: string }>(order);
    const paymentKey = `tgen_va_${seq++}`;
    const res = await ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(auth)
      .send({ orderId, paymentKey, amount: 30000 });
    const { paymentId, status } = dataOf<{ paymentId: string; status: string }>(res);
    expect(status).toBe('WAITING_FOR_DEPOSIT');
    toss.requests.length = 0;
    return { orderId, paymentKey, paymentId };
  };

  /** 토스 결제 객체 (가상계좌) */
  const tossVa = (orderId: string, paymentKey: string, status: string, approvedAt: string | null = null) =>
    approvedCardPayment(
      { method: 'GET', path: '', headers: {}, body: { orderId, paymentKey, amount: 30000 } },
      { status, method: '가상계좌', card: null, approvedAt, virtualAccount },
    );

  const webhook = (body: Record<string, unknown>) => ctx.http().post('/api/v1/pg-webhooks/toss').send(body);
  const statusChanged = (orderId: string, paymentKey: string, status: string) => ({
    eventType: 'PAYMENT_STATUS_CHANGED',
    createdAt: `2026-09-28T10:00:00.${String(seq++).padStart(6, '0')}`,
    data: tossVa(orderId, paymentKey, status, status === 'DONE' ? '2026-09-28T10:00:00+09:00' : null),
  });

  const paymentStatus = async (paymentId: string) =>
    (await ctx.dataSource.query<{ status: string }[]>('SELECT status FROM tb_payment WHERE id = $1', [paymentId]))[0]
      .status;
  const webhookRows = () =>
    ctx.dataSource.query<{ event_type: string; status: string; error: string | null }[]>(
      'SELECT event_type, status, error FROM tb_pg_webhook_event ORDER BY received_at DESC',
    );
  const tossLookups = () => toss.requests.filter((request) => request.method === 'GET');

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), TOSS_API_TIMEOUT_MS: '300' });
    service = await onboardPayableService(ctx);
  });
  beforeEach(() => {
    toss.respond((request) => {
      if (request.method === 'POST') {
        return {
          status: 200,
          body: approvedCardPayment(request, {
            status: 'WAITING_FOR_DEPOSIT',
            method: '가상계좌',
            card: null,
            approvedAt: null,
            virtualAccount,
          }),
        };
      }
      const paymentKey = decodeURIComponent(request.path.split('/').pop() ?? '');
      return tossState.get(paymentKey) ?? { status: 404, body: { code: 'NOT_FOUND_PAYMENT', message: '없음' } };
    });
  });
  afterEach(() => {
    toss.reset();
    tossState.clear();
  });
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  it('입금 완료 웹훅 → 토스 조회로 재확인 후 DONE, 주문 PAID, 원장, PAYMENT_CONFIRMED', async () => {
    const { orderId, paymentKey, paymentId } = await waitingPayment();
    tossState.set(paymentKey, { status: 200, body: tossVa(orderId, paymentKey, 'DONE', '2026-09-28T10:00:00+09:00') });

    const res = await webhook(statusChanged(orderId, paymentKey, 'DONE'));

    expect(res.status).toBe(200);
    expect(await paymentStatus(paymentId)).toBe('DONE');
    const [order] = await ctx.dataSource.query<{ status: string }[]>('SELECT status FROM tb_order WHERE id = $1', [
      orderId,
    ]);
    expect(order.status).toBe('PAID');
    const events = await ctx.dataSource.query<{ event_type: string }[]>(
      'SELECT event_type FROM tb_outbox_event WHERE aggregate_id = $1 ORDER BY occurred_at',
      [paymentId],
    );
    expect(events.map((event) => event.event_type)).toEqual(['PAYMENT_WAITING_FOR_DEPOSIT', 'PAYMENT_CONFIRMED']);
    expect((await webhookRows())[0]).toMatchObject({ event_type: 'PAYMENT_STATUS_CHANGED', status: 'PROCESSED' });
  });

  it('페이로드를 믿지 않는다: 웹훅이 DONE이라 해도 토스 조회가 입금 대기면 그대로', async () => {
    const { orderId, paymentKey, paymentId } = await waitingPayment();
    tossState.set(paymentKey, { status: 200, body: tossVa(orderId, paymentKey, 'WAITING_FOR_DEPOSIT') });

    await webhook(statusChanged(orderId, paymentKey, 'DONE'));

    expect(await paymentStatus(paymentId)).toBe('WAITING_FOR_DEPOSIT');
    expect(tossLookups()).toHaveLength(1);
  });

  it('DEPOSIT_CALLBACK 형식(orderId만 옴)도 처리한다', async () => {
    const { orderId, paymentKey, paymentId } = await waitingPayment();
    tossState.set(paymentKey, { status: 200, body: tossVa(orderId, paymentKey, 'DONE', '2026-09-28T10:00:00+09:00') });

    await webhook({
      createdAt: '2026-09-28T10:00:00.000000',
      secret: 'ps_va_secret',
      status: 'DONE',
      transactionKey: `tx_${seq++}`,
      orderId,
    });

    expect(await paymentStatus(paymentId)).toBe('DONE');
    expect((await webhookRows())[0]).toMatchObject({ event_type: 'DEPOSIT_CALLBACK', status: 'PROCESSED' });
  });

  it('같은 웹훅이 다시 오면 무시한다 (수신 기록 1건, 토스 조회 1번)', async () => {
    const { orderId, paymentKey } = await waitingPayment();
    tossState.set(paymentKey, { status: 200, body: tossVa(orderId, paymentKey, 'DONE', '2026-09-28T10:00:00+09:00') });
    const body = statusChanged(orderId, paymentKey, 'DONE');
    const before = (await webhookRows()).length;

    const first = await webhook(body);
    const again = await webhook(body);

    expect([first.status, again.status]).toEqual([200, 200]);
    expect((await webhookRows()).length).toBe(before + 1);
    expect(tossLookups()).toHaveLength(1);
  });

  it('입금 전 가상계좌 만료 → EXPIRED + PAYMENT_FAILED, 주문은 다시 결제·만료 가능', async () => {
    const { orderId, paymentKey, paymentId } = await waitingPayment();
    tossState.set(paymentKey, { status: 200, body: tossVa(orderId, paymentKey, 'EXPIRED') });

    await webhook(statusChanged(orderId, paymentKey, 'EXPIRED'));

    expect(await paymentStatus(paymentId)).toBe('EXPIRED');
    const events = await ctx.dataSource.query<{ event_type: string }[]>(
      `SELECT event_type FROM tb_outbox_event WHERE aggregate_id = $1 AND event_type = 'PAYMENT_FAILED'`,
      [paymentId],
    );
    expect(events).toHaveLength(1);
  });

  it('hub가 모르는 결제의 웹훅은 IGNORED로 기록하고 200', async () => {
    const res = await webhook(statusChanged('00000000-0000-4000-8000-000000000000', 'tgen_unknown', 'DONE'));

    expect(res.status).toBe(200);
    expect((await webhookRows())[0]).toMatchObject({ status: 'IGNORED' });
  });

  it('토스 재확인이 실패해도 200 (토스 재전송 폭주 방지) — FAILED로 남기고 대사 배치가 이어받는다', async () => {
    const { orderId, paymentKey, paymentId } = await waitingPayment();
    tossState.set(paymentKey, { status: 200, body: {}, delayMs: 1000 });

    const res = await webhook(statusChanged(orderId, paymentKey, 'DONE'));

    expect(res.status).toBe(200);
    expect(await paymentStatus(paymentId)).toBe('WAITING_FOR_DEPOSIT');
    expect((await webhookRows())[0]).toMatchObject({ status: 'FAILED' });
    expect((await webhookRows())[0].error).toContain('토스');
  });

  it('웹훅을 놓쳐도 대사 배치가 10분 넘은 입금 대기 결제를 토스 조회로 확정한다', async () => {
    const { orderId, paymentKey, paymentId } = await waitingPayment();
    tossState.set(paymentKey, { status: 200, body: tossVa(orderId, paymentKey, 'DONE', '2026-09-28T10:00:00+09:00') });

    await ctx.app.get(PaymentReconciler).reconcileDue(new Date(Date.now() + 11 * 60_000));

    expect(await paymentStatus(paymentId)).toBe('DONE');
  });

  it('입금 대기 결제는 10분이 안 지났으면 대사 배치가 건드리지 않는다', async () => {
    const { orderId, paymentKey, paymentId } = await waitingPayment();
    tossState.set(paymentKey, { status: 200, body: tossVa(orderId, paymentKey, 'DONE', '2026-09-28T10:00:00+09:00') });

    await ctx.app.get(PaymentReconciler).reconcileDue(new Date(Date.now() + 3 * 60_000));

    expect(await paymentStatus(paymentId)).toBe('WAITING_FOR_DEPOSIT');
  });
});
