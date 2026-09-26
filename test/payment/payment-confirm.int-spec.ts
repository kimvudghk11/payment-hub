import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Payment } from '../../src/payment/domain/payment.entity';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss, approvedCardPayment } from '../support/fake-toss';
import { IntegrationApp, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface PaymentData {
  paymentId: string;
  orderId: string;
  status: string;
  amount: number;
  refundedAmount: number;
  refundableAmount: number;
  currency: string;
  method: Record<string, unknown> | null;
  receiptUrl: string | null;
  approvedAt: string | null;
  failure: { code: string; message: string } | null;
}

let seq = 0;

describe('서비스 API — 결제 승인 POST /payments/confirm', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let service: PayableService;

  const createOrder = async (target: PayableService = service, totalAmount = 30000): Promise<string> => {
    const res = await ctx
      .http()
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${target.apiKey}`)
      .send({
        externalOrderId: `pay-order-${Date.now()}-${seq++}`,
        externalUserId: 'user-123',
        orderName: '프로 요금제 1개월',
        items: [
          { productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: totalAmount, quantity: 1 },
        ],
        totalAmount,
      });
    if (res.status !== 201) throw new Error(`주문 등록 실패: ${res.status} ${JSON.stringify(res.body)}`);
    return dataOf<{ orderId: string }>(res).orderId;
  };

  const confirm = (body: Record<string, unknown>, target: PayableService = service) =>
    ctx.http().post('/api/v1/payments/confirm').set('Authorization', `Bearer ${target.apiKey}`).send(body);

  const paymentKey = () => `tgen_${Date.now()}_${seq++}`;

  const paymentRows = (orderId: string) =>
    ctx.dataSource.query<{ id: string; status: string; failure_code: string | null }[]>(
      'SELECT id, status, failure_code FROM tb_payment WHERE order_id = $1 ORDER BY created_at',
      [orderId],
    );
  const orderStatus = async (orderId: string) =>
    (await ctx.dataSource.query<{ status: string }[]>('SELECT status FROM tb_order WHERE id = $1', [orderId]))[0]
      .status;
  const eventsOf = (paymentId: string) =>
    ctx.dataSource.query<{ id: string; event_type: string; payload: Record<string, unknown> }[]>(
      'SELECT id, event_type, payload FROM tb_outbox_event WHERE aggregate_id = $1',
      [paymentId],
    );
  const ledgerOf = (paymentId: string) =>
    ctx.dataSource.query<{ transaction_type: string; direction: string; amount: string; code: string }[]>(
      `SELECT t.transaction_type, e.direction, e.amount, a.code
         FROM tb_ledger_transaction t
         JOIN tb_ledger_entry e ON e.transaction_id = t.id
         JOIN tb_ledger_account a ON a.id = e.account_id
        WHERE t.reference_id = $1
        ORDER BY e.direction DESC`,
      [paymentId],
    );

  beforeAll(async () => {
    const baseUrl = await toss.start();
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: baseUrl, TOSS_API_TIMEOUT_MS: '300' });
    service = await onboardPayableService(ctx);
  });
  afterEach(() => toss.reset());
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  describe('승인 성공', () => {
    it('카드 승인 → 200 DONE + 결제 수단 분류, 주문 PAID', async () => {
      const orderId = await createOrder();
      const res = await confirm({ orderId, paymentKey: 'tgen_card_1', amount: 30000 });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, message: '결제가 승인되었습니다.' });
      expect(dataOf<PaymentData>(res)).toMatchObject({
        orderId,
        status: 'DONE',
        amount: 30000,
        refundedAmount: 0,
        refundableAmount: 30000,
        currency: 'KRW',
        method: {
          type: 'CARD',
          raw: '카드',
          cardCompanyCode: '11',
          cardType: 'CREDIT',
          cardNumberMasked: '433012******123*',
          installmentMonths: 0,
        },
        receiptUrl: 'https://dashboard.tosspayments.com/receipt/fake',
        approvedAt: '2026-09-27T01:16:03.000Z',
        failure: null,
      });
      expect(await orderStatus(orderId)).toBe('PAID');
    });

    it('토스에는 서비스의 시크릿 키(복호화)·hub 주문 ID·주문 금액·멱등키로 호출한다', async () => {
      const orderId = await createOrder();
      await confirm({ orderId, paymentKey: 'tgen_card_2', amount: 30000 });

      const [request] = toss.requests;
      expect(request.headers.authorization).toBe(
        `Basic ${Buffer.from(`${service.tossSecretKey}:`).toString('base64')}`,
      );
      expect(request.headers['idempotency-key']).toMatch(/^confirm:[0-9a-f]{64}$/);
      expect(request.body).toEqual({ paymentKey: 'tgen_card_2', orderId, amount: 30000 });
    });

    it('같은 트랜잭션에서 원장(차 PG 미수금 / 대 매출)과 PAYMENT_CONFIRMED 이벤트·웹훅 전달 대상을 남긴다', async () => {
      const orderId = await createOrder();
      const { paymentId } = dataOf<PaymentData>(await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 }));

      expect(await ledgerOf(paymentId)).toEqual([
        { transaction_type: 'PAYMENT_CAPTURED', direction: 'DEBIT', amount: '30000', code: 'PG_RECEIVABLE' },
        { transaction_type: 'PAYMENT_CAPTURED', direction: 'CREDIT', amount: '30000', code: 'REVENUE' },
      ]);

      const [event] = await eventsOf(paymentId);
      expect(event).toMatchObject({
        event_type: 'PAYMENT_CONFIRMED',
        payload: { paymentId, orderId, externalUserId: 'user-123', status: 'DONE', amount: 30000, methodType: 'CARD' },
      });
      const deliveries = await ctx.dataSource.query<{ status: string; target_url: string }[]>(
        'SELECT status, target_url FROM tb_webhook_delivery WHERE event_id = $1',
        [event.id],
      );
      expect(deliveries).toEqual([{ status: 'PENDING', target_url: 'https://svc.example.com/webhooks/payment-hub' }]);
    });

    it('원장 계정은 서비스·통화별로 한 번만 만들고 재사용한다', async () => {
      for (let i = 0; i < 2; i++) {
        await confirm({ orderId: await createOrder(), paymentKey: paymentKey(), amount: 30000 });
      }

      const accounts = await ctx.dataSource.query<{ code: string; type: string; count: string }[]>(
        `SELECT code, type, count(*) FROM tb_ledger_account WHERE service_id = $1 GROUP BY code, type ORDER BY code`,
        [service.serviceId],
      );
      expect(accounts).toEqual([
        { code: 'PG_RECEIVABLE', type: 'ASSET', count: '1' },
        { code: 'REVENUE', type: 'REVENUE', count: '1' },
      ]);
    });

    it('webhookUrl이 없는 서비스는 이벤트만 남기고(재조회용) 전달 대상은 만들지 않는다', async () => {
      const noHook = await onboardPayableService(ctx, { webhookUrl: null });
      const orderId = await createOrder(noHook);
      const { paymentId } = dataOf<PaymentData>(
        await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 }, noHook),
      );

      const [event] = await eventsOf(paymentId);
      expect(event.event_type).toBe('PAYMENT_CONFIRMED');
      const deliveries = await ctx.dataSource.query<unknown[]>(
        'SELECT 1 FROM tb_webhook_delivery WHERE event_id = $1',
        [event.id],
      );
      expect(deliveries).toHaveLength(0);
    });

    it('가상계좌 → 200 WAITING_FOR_DEPOSIT + 입금 안내, 주문은 PENDING·원장 없음·입금 대기 이벤트', async () => {
      toss.respond((request) => ({
        status: 200,
        body: approvedCardPayment(request, {
          status: 'WAITING_FOR_DEPOSIT',
          method: '가상계좌',
          approvedAt: null,
          card: null,
          virtualAccount: { accountNumber: 'X6505636518308', bankCode: '20', dueDate: '2026-09-28T23:59:59+09:00' },
        }),
      }));
      const orderId = await createOrder();
      const res = await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 });

      expect(res.status).toBe(200);
      const payment = dataOf<PaymentData>(res);
      expect(payment).toMatchObject({
        status: 'WAITING_FOR_DEPOSIT',
        refundableAmount: 0,
        approvedAt: null,
        method: {
          type: 'VIRTUAL_ACCOUNT',
          bankCode: '20',
          virtualAccountNumber: 'X6505636518308',
          virtualAccountDueAt: '2026-09-28T14:59:59.000Z',
        },
      });
      expect(await orderStatus(orderId)).toBe('PENDING');
      expect(await ledgerOf(payment.paymentId)).toEqual([]);
      expect((await eventsOf(payment.paymentId)).map((event) => event.event_type)).toEqual([
        'PAYMENT_WAITING_FOR_DEPOSIT',
      ]);
    });
  });

  describe('멱등 — 같은 paymentKey 재요청', () => {
    it('승인된 결제는 토스를 다시 부르지 않고 같은 결과를 200으로 준다', async () => {
      const orderId = await createOrder();
      const key = paymentKey();
      const first = await confirm({ orderId, paymentKey: key, amount: 30000 });
      const again = await confirm({ orderId, paymentKey: key, amount: 30000 });

      expect(again.status).toBe(200);
      expect(dataOf<PaymentData>(again).paymentId).toBe(dataOf<PaymentData>(first).paymentId);
      expect(toss.requests).toHaveLength(1);
    });

    it('동시에 같은 요청이 와도 토스 승인은 한 번 — 나머지는 409 PAYMENT_IN_PROGRESS', async () => {
      toss.respond((request) => ({ status: 200, body: approvedCardPayment(request), delayMs: 150 }));
      const orderId = await createOrder();
      const key = paymentKey();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => confirm({ orderId, paymentKey: key, amount: 30000 })),
      );

      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      for (const res of results.filter((r) => r.status !== 200)) {
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('PAYMENT_IN_PROGRESS');
      }
      expect(toss.requests).toHaveLength(1);
      expect(await paymentRows(orderId)).toHaveLength(1);
    });

    it('두 요청이 동시에 승인 전 검증 구간에 있어도 주문 락으로 직렬화된다 (결정적 재현)', async () => {
      // HTTP 동시 요청만으로는 검증 구간이 겹치지 않을 수 있어, 트랜잭션 안의 조회를 늦춰 구간을 겹치게 만든다
      const payments = ctx.app.get<Repository<Payment>>(getRepositoryToken(Payment));
      const original = payments.findOneBy.bind(payments);
      const spy = jest.spyOn(payments, 'findOneBy').mockImplementation(async (where) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return original(where);
      });
      try {
        const orderId = await createOrder();
        const results = await Promise.all([
          confirm({ orderId, paymentKey: paymentKey(), amount: 30000 }),
          confirm({ orderId, paymentKey: paymentKey(), amount: 30000 }),
        ]);

        expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
        expect(toss.requests).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('승인 전 검증 — 토스를 호출하지 않고 결제도 남기지 않는다', () => {
    it('금액이 주문 결제 금액과 다르면 400 PAYMENT_AMOUNT_MISMATCH', async () => {
      const orderId = await createOrder();
      const res = await confirm({ orderId, paymentKey: paymentKey(), amount: 100 });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('PAYMENT_AMOUNT_MISMATCH');
      expect(toss.requests).toHaveLength(0);
      expect(await paymentRows(orderId)).toHaveLength(0);
    });

    it('다른 서비스의 주문은 404 ORDER_NOT_FOUND (존재 숨김)', async () => {
      const other = await onboardPayableService(ctx);
      const orderId = await createOrder(other);
      const res = await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 });

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('ORDER_NOT_FOUND');
      expect(toss.requests).toHaveLength(0);
    });

    it('만료 시각이 지난 주문은 409 ORDER_EXPIRED', async () => {
      const orderId = await createOrder();
      await ctx.dataSource.query(`UPDATE tb_order SET expires_at = now() - interval '1 second' WHERE id = $1`, [
        orderId,
      ]);
      const res = await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('ORDER_EXPIRED');
    });

    it('이미 결제된 주문에 다른 paymentKey로 승인하면 409 ORDER_ALREADY_PAID', async () => {
      const orderId = await createOrder();
      await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 });
      const res = await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('ORDER_ALREADY_PAID');
      expect(toss.requests).toHaveLength(1);
    });

    it('토스 자격증명이 없는 서비스는 500 PG_CREDENTIAL_NOT_FOUND — 결제 기록 없음', async () => {
      const noCredential = await onboardPayableService(ctx);
      await ctx.dataSource.query('UPDATE tb_pg_credential SET is_active = false WHERE service_id = $1', [
        noCredential.serviceId,
      ]);
      const orderId = await createOrder(noCredential);
      const res = await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 }, noCredential);

      expect(res.status).toBe(500);
      expect(errorOf(res).code).toBe('PG_CREDENTIAL_NOT_FOUND');
      expect(await paymentRows(orderId)).toHaveLength(0);
    });

    it('필수 값이 없으면 400 INVALID_REQUEST + 필드별 메시지', async () => {
      const res = await confirm({ orderId: 'not-a-uuid', amount: 0 });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('INVALID_REQUEST');
      const fields = (errorOf(res).detail?.errors as { field: string }[]).map((error) => error.field);
      expect(fields).toEqual(expect.arrayContaining(['orderId', 'paymentKey', 'amount']));
    });
  });

  describe('토스 거절 — 확정 실패', () => {
    it('402 PAYMENT_REJECTED + 토스 원본 사유, 결제는 FAILED로 남고 주문은 PENDING', async () => {
      toss.respond(() => ({
        status: 403,
        body: { code: 'REJECT_CARD_PAYMENT', message: '한도초과 혹은 잔액부족으로 결제에 실패했습니다.' },
      }));
      const orderId = await createOrder();
      const res = await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 });

      expect(res.status).toBe(402);
      const error = errorOf(res);
      expect(error.code).toBe('PAYMENT_REJECTED');
      expect(error.detail).toMatchObject({
        pgCode: 'REJECT_CARD_PAYMENT',
        pgMessage: '한도초과 혹은 잔액부족으로 결제에 실패했습니다.',
        paymentStatus: 'FAILED',
      });

      const [row] = await paymentRows(orderId);
      expect(row).toMatchObject({ id: error.detail?.paymentId, status: 'FAILED', failure_code: 'REJECT_CARD_PAYMENT' });
      expect(await orderStatus(orderId)).toBe('PENDING');
      expect((await eventsOf(row.id)).map((event) => event.event_type)).toEqual(['PAYMENT_FAILED']);
    });

    it('실패한 뒤 사용자가 다른 수단으로 다시 결제할 수 있다 (실패 시도는 주문을 막지 않음)', async () => {
      toss.respond(() => ({ status: 403, body: { code: 'REJECT_CARD_PAYMENT', message: '거절' } }));
      const orderId = await createOrder();
      await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 });

      toss.reset();
      const retry = await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 });

      expect(retry.status).toBe(200);
      expect((await paymentRows(orderId)).map((row) => row.status)).toEqual(['FAILED', 'DONE']);
    });

    it('실패한 paymentKey를 다시 보내면 토스를 다시 부르지 않고 같은 실패를 준다', async () => {
      toss.respond(() => ({ status: 403, body: { code: 'REJECT_CARD_PAYMENT', message: '거절' } }));
      const orderId = await createOrder();
      const key = paymentKey();
      await confirm({ orderId, paymentKey: key, amount: 30000 });
      const again = await confirm({ orderId, paymentKey: key, amount: 30000 });

      expect(again.status).toBe(402);
      expect(errorOf(again).detail).toMatchObject({ pgCode: 'REJECT_CARD_PAYMENT' });
      expect(toss.requests).toHaveLength(1);
    });

    it('토스 키 인증 실패(hub 설정 문제)는 502 PG_ERROR — 사용자 카드 문제가 아님', async () => {
      toss.respond(() => ({ status: 401, body: { code: 'UNAUTHORIZED_KEY', message: '인증되지 않은 시크릿 키' } }));
      const orderId = await createOrder();
      const res = await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 });

      expect(res.status).toBe(502);
      expect(errorOf(res)).toMatchObject({
        code: 'PG_ERROR',
        detail: { pgCode: 'UNAUTHORIZED_KEY', paymentStatus: 'FAILED' },
      });
    });
  });

  describe('결과 불명 — UNKNOWN으로 남기고 대사가 확정', () => {
    it('타임아웃 → 504 PG_TIMEOUT + paymentId, 결제 UNKNOWN, 주문 PENDING, 이벤트 없음', async () => {
      toss.respond((request) => ({ status: 200, body: approvedCardPayment(request), delayMs: 1000 }));
      const orderId = await createOrder();
      const res = await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 });

      expect(res.status).toBe(504);
      const error = errorOf(res);
      expect(error.code).toBe('PG_TIMEOUT');
      expect(error.detail).toMatchObject({ paymentStatus: 'UNKNOWN' });

      const [row] = await paymentRows(orderId);
      expect(row).toMatchObject({ id: error.detail?.paymentId, status: 'UNKNOWN' });
      expect(await orderStatus(orderId)).toBe('PENDING');
      expect(await eventsOf(row.id)).toEqual([]);
    });

    it('UNKNOWN 결제가 있으면 같은·다른 paymentKey 모두 409 PAYMENT_IN_PROGRESS (이중 결제 방지)', async () => {
      toss.respond((request) => ({ status: 200, body: approvedCardPayment(request), delayMs: 1000 }));
      const orderId = await createOrder();
      const key = paymentKey();
      await confirm({ orderId, paymentKey: key, amount: 30000 });
      toss.reset();

      for (const retryKey of [key, paymentKey()]) {
        const res = await confirm({ orderId, paymentKey: retryKey, amount: 30000 });
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('PAYMENT_IN_PROGRESS');
      }
      expect(toss.requests).toHaveLength(0);
    });

    it('토스 5xx → 502 PG_ERROR, 결제 UNKNOWN', async () => {
      toss.respond(() => ({ status: 500, body: { code: 'FAILED_INTERNAL_SYSTEM_PROCESSING', message: '내부 오류' } }));
      const orderId = await createOrder();
      const res = await confirm({ orderId, paymentKey: paymentKey(), amount: 30000 });

      expect(res.status).toBe(502);
      expect(errorOf(res)).toMatchObject({ code: 'PG_ERROR', detail: { paymentStatus: 'UNKNOWN' } });
      expect((await paymentRows(orderId)).map((row) => row.status)).toEqual(['UNKNOWN']);
    });
  });
});
