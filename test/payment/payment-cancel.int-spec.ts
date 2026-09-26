import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderItem } from '../../src/order/domain/order-item.entity';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss, approvedCardPayment, canceledPayment } from '../support/fake-toss';
import { IntegrationApp, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface CancelResult {
  cancel: {
    paymentCancelId: string;
    status: string;
    amount: number;
    reasonCode: string;
    canceledAt: string | null;
    items: { orderItemId: string; quantity: number; amount: number }[];
  };
  payment: { paymentId: string; status: string; refundedAmount: number; refundableAmount: number };
}

let seq = 0;

describe('서비스 API — 환불 POST /payments/:paymentId/cancel', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let service: PayableService;

  /** 프로 요금제 24000 × 1 + 저장공간 3000 × 2 = 30000 결제 (DONE) */
  const paid = async (target: PayableService = service) => {
    const auth = { Authorization: `Bearer ${target.apiKey}` };
    const order = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth)
      .send({
        externalOrderId: `cancel-order-${Date.now()}-${seq++}`,
        externalUserId: 'user-1',
        orderName: '프로 요금제 외 1건',
        items: [
          { productType: 'PLAN', externalProductId: 'pro', productName: '프로 요금제', unitPrice: 24000, quantity: 1 },
          { productType: 'PLAN', externalProductId: 'storage', productName: '저장공간', unitPrice: 3000, quantity: 2 },
        ],
        totalAmount: 30000,
      });
    const { orderId, items } = dataOf<{ orderId: string; items: { orderItemId: string; lineNo: number }[] }>(order);
    const confirmed = await ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(auth)
      .send({ orderId, paymentKey: `tgen_cancel_${seq++}`, amount: 30000 });
    const { paymentId } = dataOf<{ paymentId: string }>(confirmed);
    toss.requests.length = 0; // 이후 검증은 취소 호출만 본다
    const byLine = [...items].sort((a, b) => a.lineNo - b.lineNo);
    return { orderId, paymentId, planItemId: byLine[0].orderItemId, storageItemId: byLine[1].orderItemId };
  };

  const cancel = (paymentId: string, body: Record<string, unknown>, target: PayableService = service) =>
    ctx.http().post(`/api/v1/payments/${paymentId}/cancel`).set('Authorization', `Bearer ${target.apiKey}`).send(body);

  const storageRefund = (storageItemId: string, overrides: Record<string, unknown> = {}) => ({
    amount: 3000,
    reasonCode: 'USER_REQUEST',
    reasonDetail: '저장공간 1개 환불',
    idempotencyKey: `refund-${seq++}`,
    items: [{ orderItemId: storageItemId, quantity: 1, amount: 3000 }],
    ...overrides,
  });

  const cancelRows = (paymentId: string) =>
    ctx.dataSource.query<{ id: string; status: string; failure_code: string | null }[]>(
      'SELECT id, status, failure_code FROM tb_payment_cancel WHERE payment_id = $1 ORDER BY created_at',
      [paymentId],
    );

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), TOSS_API_TIMEOUT_MS: '300' });
    service = await onboardPayableService(ctx);
  });
  // 승인은 카드 승인 성공, 취소는 취소 성공으로 응답
  beforeEach(() =>
    toss.respond((request) => ({
      status: 200,
      body: request.path.endsWith('/cancel') ? canceledPayment(request) : approvedCardPayment(request),
    })),
  );
  afterEach(() => toss.reset());
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  describe('환불 성공', () => {
    it('부분 환불 → 200, 취소 DONE + 결제 PARTIAL_CANCELED·환불 가능 금액 갱신', async () => {
      const { paymentId, storageItemId } = await paid();
      const res = await cancel(paymentId, storageRefund(storageItemId));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ message: '환불이 완료되었습니다.' });
      expect(dataOf<CancelResult>(res)).toMatchObject({
        cancel: {
          status: 'DONE',
          amount: 3000,
          reasonCode: 'USER_REQUEST',
          canceledAt: '2026-09-28T00:00:00.000Z',
          items: [{ orderItemId: storageItemId, quantity: 1, amount: 3000 }],
        },
        payment: { paymentId, status: 'PARTIAL_CANCELED', refundedAmount: 3000, refundableAmount: 27000 },
      });
    });

    it('토스에는 취소 사유(reasonDetail)·금액·취소 건 단위 멱등키로 호출한다', async () => {
      const { paymentId, storageItemId } = await paid();
      const { cancel: created } = dataOf<CancelResult>(await cancel(paymentId, storageRefund(storageItemId)));

      const [request] = toss.requests;
      expect(request.path).toMatch(/^\/v1\/payments\/tgen_cancel_\d+\/cancel$/);
      expect(request.body).toEqual({ cancelReason: '저장공간 1개 환불', cancelAmount: 3000 });
      expect(request.headers['idempotency-key']).toBe(`cancel:${created.paymentCancelId}`);
    });

    it('같은 트랜잭션에서 주문·항목 취소 수량, 원장 반대 분개, PAYMENT_CANCELED 이벤트를 남긴다', async () => {
      const { orderId, paymentId, storageItemId } = await paid();
      const { cancel: created } = dataOf<CancelResult>(await cancel(paymentId, storageRefund(storageItemId)));

      const [order] = await ctx.dataSource.query<{ status: string }[]>('SELECT status FROM tb_order WHERE id = $1', [
        orderId,
      ]);
      expect(order.status).toBe('PARTIAL_CANCELED');
      const items = await ctx.dataSource.query<{ id: string; canceled_quantity: number }[]>(
        'SELECT id, canceled_quantity FROM tb_order_item WHERE order_id = $1',
        [orderId],
      );
      expect(items.find((item) => item.id === storageItemId)?.canceled_quantity).toBe(1);

      const ledger = await ctx.dataSource.query<{ direction: string; amount: string; code: string }[]>(
        `SELECT e.direction, e.amount, a.code FROM tb_ledger_transaction t
           JOIN tb_ledger_entry e ON e.transaction_id = t.id JOIN tb_ledger_account a ON a.id = e.account_id
          WHERE t.transaction_type = 'PAYMENT_CANCELED' AND t.reference_id = $1 ORDER BY e.direction DESC`,
        [created.paymentCancelId],
      );
      expect(ledger).toEqual([
        { direction: 'DEBIT', amount: '3000', code: 'REFUND' },
        { direction: 'CREDIT', amount: '3000', code: 'PG_RECEIVABLE' },
      ]);

      const events = await ctx.dataSource.query<{ event_type: string; payload: Record<string, unknown> }[]>(
        `SELECT event_type, payload FROM tb_outbox_event WHERE aggregate_id = $1 AND event_type = 'PAYMENT_CANCELED'`,
        [paymentId],
      );
      expect(events).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            status: 'PARTIAL_CANCELED',
            refundedAmount: 3000,
            cancel: expect.objectContaining({ paymentCancelId: created.paymentCancelId, amount: 3000 }) as unknown,
          }) as unknown,
        }),
      ]);
    });

    it('남은 금액을 모두 환불하면 결제·주문 CANCELED, 환불 가능 금액·수량 0', async () => {
      const { orderId, paymentId, storageItemId } = await paid();
      await cancel(paymentId, storageRefund(storageItemId));
      const rest = await cancel(paymentId, storageRefund(storageItemId, { amount: 27000, items: [] }));

      expect(dataOf<CancelResult>(rest).payment).toMatchObject({ status: 'CANCELED', refundableAmount: 0 });
      const [order] = await ctx.dataSource.query<{ status: string }[]>('SELECT status FROM tb_order WHERE id = $1', [
        orderId,
      ]);
      expect(order.status).toBe('CANCELED');
      const refundable = await ctx
        .http()
        .get(`/api/v1/payments/${paymentId}/refundable`)
        .set('Authorization', `Bearer ${service.apiKey}`);
      expect(dataOf<{ refundableAmount: number }>(refundable).refundableAmount).toBe(0);
    });

    it('결제 단건 조회에 취소 이력이 붙는다', async () => {
      const { paymentId, storageItemId } = await paid();
      await cancel(paymentId, storageRefund(storageItemId));
      const res = await ctx
        .http()
        .get(`/api/v1/payments/${paymentId}`)
        .set('Authorization', `Bearer ${service.apiKey}`);

      expect(dataOf<{ cancels: unknown[] }>(res).cancels).toEqual([
        expect.objectContaining({ status: 'DONE', amount: 3000, reasonCode: 'USER_REQUEST' }),
      ]);
    });
  });

  describe('멱등 — 같은 idempotencyKey 재요청', () => {
    it('같은 내용이면 토스를 다시 부르지 않고 같은 취소를 200으로', async () => {
      const { paymentId, storageItemId } = await paid();
      const body = storageRefund(storageItemId);
      const first = dataOf<CancelResult>(await cancel(paymentId, body));
      const again = await cancel(paymentId, body);

      expect(again.status).toBe(200);
      expect(dataOf<CancelResult>(again).cancel.paymentCancelId).toBe(first.cancel.paymentCancelId);
      expect(toss.requests).toHaveLength(1);
    });

    it('내용이 다르면 409 CANCEL_IDEMPOTENCY_CONFLICT', async () => {
      const { paymentId, storageItemId } = await paid();
      const body = storageRefund(storageItemId);
      await cancel(paymentId, body);
      const conflict = await cancel(paymentId, { ...body, amount: 6000, items: [] });

      expect(conflict.status).toBe(409);
      expect(errorOf(conflict).code).toBe('CANCEL_IDEMPOTENCY_CONFLICT');
    });
  });

  describe('환불 전 검증 — 토스를 호출하지 않고 취소도 남기지 않는다', () => {
    it('환불 가능 금액 초과 → 400 CANCEL_AMOUNT_EXCEEDED + detail.refundableAmount', async () => {
      const { paymentId } = await paid();
      const res = await cancel(paymentId, storageRefund('', { amount: 30001, items: [] }));

      expect(res.status).toBe(400);
      expect(errorOf(res)).toMatchObject({ code: 'CANCEL_AMOUNT_EXCEEDED', detail: { refundableAmount: 30000 } });
      expect(toss.requests).toHaveLength(0);
      expect(await cancelRows(paymentId)).toHaveLength(0);
    });

    it('취소 가능 수량 초과 → 400 INVALID_REQUEST + 필드 메시지', async () => {
      const { paymentId, storageItemId } = await paid();
      const res = await cancel(
        paymentId,
        storageRefund(storageItemId, {
          amount: 9000,
          items: [{ orderItemId: storageItemId, quantity: 3, amount: 9000 }],
        }),
      );

      expect(res.status).toBe(400);
      expect(errorOf(res).detail?.errors).toEqual([
        { field: 'items.0.quantity', message: '취소 가능 수량(2개)을 넘었습니다.' },
      ]);
    });

    it('다른 서비스의 결제 → 404 PAYMENT_NOT_FOUND', async () => {
      const other = await onboardPayableService(ctx);
      const { paymentId } = await paid(other);
      const res = await cancel(paymentId, storageRefund('', { items: [] }));

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PAYMENT_NOT_FOUND');
    });

    it('가상계좌 결제는 환불 계좌가 필요하다 → 400 INVALID_REQUEST', async () => {
      const { paymentId } = await paid();
      await ctx.dataSource.query(`UPDATE tb_payment SET method_type = 'VIRTUAL_ACCOUNT' WHERE id = $1`, [paymentId]);
      const res = await cancel(paymentId, storageRefund('', { items: [] }));

      expect(res.status).toBe(400);
      expect(errorOf(res).detail?.errors).toEqual([
        { field: 'refundReceiveAccount', message: '가상계좌 결제는 환불 계좌가 필요합니다.' },
      ]);

      const withAccount = await cancel(
        paymentId,
        storageRefund('', {
          items: [],
          refundReceiveAccount: { bankCode: '20', accountNumber: '1002123456789', holderName: '홍길동' },
        }),
      );
      expect(withAccount.status).toBe(200);
      expect(toss.requests[0].body.refundReceiveAccount).toEqual({
        bank: '20',
        accountNumber: '1002123456789',
        holderName: '홍길동',
      });
    });

    it('필수 값이 없으면 400 INVALID_REQUEST', async () => {
      const { paymentId } = await paid();
      const res = await cancel(paymentId, { amount: 0 });

      expect(res.status).toBe(400);
      const fields = (errorOf(res).detail?.errors as { field: string }[]).map((error) => error.field);
      expect(fields).toEqual(expect.arrayContaining(['amount', 'reasonCode', 'idempotencyKey']));
    });
  });

  describe('동시 요청', () => {
    it('부분 환불 둘이 동시에 와도 합계가 결제 금액을 넘지 않는다 (결정적 재현)', async () => {
      const { paymentId } = await paid();
      // 락 안의 항목 조회를 늦춰 두 요청의 검증 구간을 겹치게 만든다
      const orderItems = ctx.app.get<Repository<OrderItem>>(getRepositoryToken(OrderItem));
      const original = orderItems.findBy.bind(orderItems);
      const spy = jest.spyOn(orderItems, 'findBy').mockImplementation(async (where) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return original(where);
      });
      try {
        const results = await Promise.all([
          cancel(paymentId, storageRefund('', { amount: 20000, items: [] })),
          cancel(paymentId, storageRefund('', { amount: 20000, items: [] })),
        ]);

        expect(results.map((res) => res.status).sort()).toEqual([200, 400]);
        expect(toss.requests).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('토스 결과', () => {
    it('토스 거절 → 409 CANCEL_REJECTED + 토스 사유, 취소 FAILED, 결제는 그대로 — 다시 요청할 수 있다', async () => {
      const { paymentId, storageItemId } = await paid();
      toss.respond(() => ({
        status: 403,
        body: { code: 'NOT_CANCELABLE_AMOUNT', message: '취소 할 수 없는 금액 입니다.' },
      }));
      const res = await cancel(paymentId, storageRefund(storageItemId));

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'CANCEL_REJECTED',
        detail: { pgCode: 'NOT_CANCELABLE_AMOUNT', cancelStatus: 'FAILED' },
      });
      expect((await cancelRows(paymentId)).map((row) => row.status)).toEqual(['FAILED']);

      toss.respond((request) => ({ status: 200, body: canceledPayment(request) }));
      const retry = await cancel(paymentId, storageRefund(storageItemId));
      expect(retry.status).toBe(200);
    });

    it('토스 응답 지연 → 504 PG_TIMEOUT, 취소 UNKNOWN — 그 금액은 확정 전까지 환불 가능 금액에서 빠진다', async () => {
      const { paymentId, storageItemId } = await paid();
      toss.respond((request) => ({ status: 200, body: canceledPayment(request), delayMs: 1000 }));
      const body = storageRefund(storageItemId, { amount: 20000, items: [] });
      const res = await cancel(paymentId, body);

      expect(res.status).toBe(504);
      expect(errorOf(res)).toMatchObject({ code: 'PG_TIMEOUT', detail: { cancelStatus: 'UNKNOWN' } });
      expect((await cancelRows(paymentId)).map((row) => row.status)).toEqual(['UNKNOWN']);

      toss.reset();
      const more = await cancel(paymentId, storageRefund(storageItemId, { amount: 10001, items: [] }));
      expect(errorOf(more)).toMatchObject({ code: 'CANCEL_AMOUNT_EXCEEDED', detail: { refundableAmount: 10000 } });

      const again = await cancel(paymentId, body);
      expect(again.status).toBe(409);
      expect(errorOf(again).code).toBe('CANCEL_IN_PROGRESS');
    });
  });
});
