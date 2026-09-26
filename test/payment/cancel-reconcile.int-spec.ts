import { PaymentReconciler } from '../../src/payment/payment-reconciler';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss, approvedCardPayment, canceledPayment } from '../support/fake-toss';
import { IntegrationApp, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

const MINUTE = 60_000;
let seq = 0;

describe('환불 대사 — 결과 불명·멈춘 취소를 같은 멱등키로 토스에 다시 확인', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let reconciler: PaymentReconciler;
  let service: PayableService;

  const later = () => new Date(Date.now() + 3 * MINUTE);
  const auth = () => ({ Authorization: `Bearer ${service.apiKey}` });

  /** 결제 후 환불 요청이 토스 응답 지연으로 UNKNOWN이 된 상태 */
  const unknownCancel = async () => {
    toss.respond((request) => ({ status: 200, body: approvedCardPayment(request) }));
    const order = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth())
      .send({
        externalOrderId: `crc-${Date.now()}-${seq++}`,
        externalUserId: 'user-1',
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 30000, quantity: 1 }],
        totalAmount: 30000,
      });
    const confirmed = await ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(auth())
      .send({ orderId: dataOf<{ orderId: string }>(order).orderId, paymentKey: `tgen_crc_${seq++}`, amount: 30000 });
    const { paymentId } = dataOf<{ paymentId: string }>(confirmed);

    toss.respond((request) => ({ status: 200, body: canceledPayment(request), delayMs: 1000 }));
    const res = await ctx
      .http()
      .post(`/api/v1/payments/${paymentId}/cancel`)
      .set(auth())
      .send({ amount: 10000, reasonCode: 'USER_REQUEST', idempotencyKey: `crc-refund-${seq++}` });
    expect(errorOf(res).code).toBe('PG_TIMEOUT');
    const firstKey = toss.requests.at(-1)?.headers['idempotency-key'];
    toss.reset();
    return { paymentId, paymentCancelId: errorOf(res).detail?.paymentCancelId as string, firstKey };
  };

  const cancelRow = async (id: string) =>
    (
      await ctx.dataSource.query<{ status: string; failure_code: string | null; updated_at: Date }[]>(
        'SELECT status, failure_code, updated_at FROM tb_payment_cancel WHERE id = $1',
        [id],
      )
    )[0];
  const paymentOf = async (id: string) =>
    (
      await ctx.dataSource.query<{ status: string; refunded_amount: string }[]>(
        'SELECT status, refunded_amount FROM tb_payment WHERE id = $1',
        [id],
      )
    )[0];

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), TOSS_API_TIMEOUT_MS: '300' });
    reconciler = ctx.app.get(PaymentReconciler);
    service = await onboardPayableService(ctx);
  });
  afterEach(() => toss.reset());
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  it('토스가 처리했으면(같은 멱등키 → 원래 결과) DONE으로 확정 — 결제·원장·PAYMENT_CANCELED 반영', async () => {
    const { paymentId, paymentCancelId, firstKey } = await unknownCancel();
    toss.respond((request) => ({ status: 200, body: canceledPayment(request) }));

    await reconciler.reconcileCancelsDue(later());

    expect(toss.requests[0].headers['idempotency-key']).toBe(firstKey);
    expect(toss.requests[0].body).toMatchObject({ cancelAmount: 10000 });
    expect((await cancelRow(paymentCancelId)).status).toBe('DONE');
    expect(await paymentOf(paymentId)).toEqual({ status: 'PARTIAL_CANCELED', refunded_amount: '10000' });
    const ledger = await ctx.dataSource.query<unknown[]>(
      `SELECT 1 FROM tb_ledger_transaction WHERE transaction_type = 'PAYMENT_CANCELED' AND reference_id = $1`,
      [paymentCancelId],
    );
    expect(ledger).toHaveLength(1);
    const events = await ctx.dataSource.query<{ event_type: string }[]>(
      `SELECT event_type FROM tb_outbox_event WHERE aggregate_id = $1 AND event_type = 'PAYMENT_CANCELED'`,
      [paymentId],
    );
    expect(events).toHaveLength(1);
  });

  it('토스가 거절하면 FAILED — 잡아 두었던 금액이 다시 환불 가능해진다', async () => {
    const { paymentId, paymentCancelId } = await unknownCancel();
    toss.respond(() => ({ status: 403, body: { code: 'NOT_CANCELABLE_AMOUNT', message: '취소 불가' } }));

    await reconciler.reconcileCancelsDue(later());

    expect(await cancelRow(paymentCancelId)).toMatchObject({ status: 'FAILED', failure_code: 'NOT_CANCELABLE_AMOUNT' });
    const refundable = await ctx.http().get(`/api/v1/payments/${paymentId}/refundable`).set(auth());
    expect(dataOf<{ refundableAmount: number }>(refundable).refundableAmount).toBe(30000);
  });

  it('여전히 결과를 모르면 UNKNOWN 유지, 다음 대사 순서의 뒤로', async () => {
    const { paymentCancelId } = await unknownCancel();
    const before = (await cancelRow(paymentCancelId)).updated_at;
    toss.respond((request) => ({ status: 200, body: canceledPayment(request), delayMs: 1000 }));

    await reconciler.reconcileCancelsDue(later());

    const after = await cancelRow(paymentCancelId);
    expect(after.status).toBe('UNKNOWN');
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('선기록 뒤 토스 호출 전에 멈춘 REQUESTED 취소도 처리한다', async () => {
    const { paymentCancelId } = await unknownCancel();
    await ctx.dataSource.query(`UPDATE tb_payment_cancel SET status = 'REQUESTED' WHERE id = $1`, [paymentCancelId]);
    toss.respond((request) => ({ status: 200, body: canceledPayment(request) }));

    await reconciler.reconcileCancelsDue(later());

    expect((await cancelRow(paymentCancelId)).status).toBe('DONE');
  });

  it('한 건이 실패해도(복호화할 수 없는 토스 키) 나머지 환불 대사는 계속된다', async () => {
    const good = await unknownCancel();
    const originalService = service;
    service = await onboardPayableService(ctx);
    const bad = await unknownCancel();
    service = originalService;
    await ctx.dataSource.query(
      `UPDATE tb_pg_credential SET secret_key_enc = decode(repeat('00', 40), 'hex')
        WHERE service_id = (SELECT service_id FROM tb_payment_cancel WHERE id = $1)`,
      [bad.paymentCancelId],
    );
    await ctx.dataSource.query(`UPDATE tb_payment_cancel SET updated_at = now() - interval '1 hour' WHERE id = $1`, [
      bad.paymentCancelId,
    ]);
    toss.respond((request) => ({ status: 200, body: canceledPayment(request) }));

    const result = await reconciler.reconcileCancelsDue(later());

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect((await cancelRow(good.paymentCancelId)).status).toBe('DONE');
    expect((await cancelRow(bad.paymentCancelId)).status).toBe('UNKNOWN');
  });

  it('방금 생긴 결과 불명 취소는 건드리지 않는다 (2분 이상 지난 것만)', async () => {
    const { paymentCancelId } = await unknownCancel();

    await reconciler.reconcileCancelsDue(new Date());

    expect(toss.requests).toHaveLength(0);
    expect((await cancelRow(paymentCancelId)).status).toBe('UNKNOWN');
  });
});
