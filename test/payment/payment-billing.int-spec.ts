import { PaymentReconciler } from '../../src/payment/payment-reconciler';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss, FakeTossRequest, approvedCardPayment } from '../support/fake-toss';
import { IntegrationApp, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

let seq = 0;

/** 토스 자동결제 승인 응답: paymentKey는 토스가 만든다 */
const billingPayment = (request: FakeTossRequest, overrides: Record<string, unknown> = {}) =>
  approvedCardPayment(
    { ...request, body: { ...request.body, paymentKey: `tbill_${String(request.body.orderId)}` } },
    overrides,
  );

describe('서비스 API — 자동결제 POST /payments/billing', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let service: PayableService;
  let other: PayableService;

  const auth = (target: PayableService = service) => ({ Authorization: `Bearer ${target.apiKey}` });

  const registerCard = async (externalUserId = 'user-1', target: PayableService = service): Promise<string> => {
    const res = await ctx
      .http()
      .post('/api/v1/billing-keys')
      .set(auth(target))
      .send({ externalUserId, customerKey: `c_${externalUserId}_${seq++}`, authKey: `bln_${seq++}` });
    return dataOf<{ billingKeyId: string }>(res).billingKeyId;
  };
  const createOrder = async (externalUserId = 'user-1'): Promise<string> => {
    const res = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth())
      .send({
        externalOrderId: `bill-${Date.now()}-${seq++}`,
        externalUserId,
        externalSubscriptionId: 'sub-77',
        orderName: '프로 요금제 10월',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 29000, quantity: 1 }],
        totalAmount: 29000,
      });
    return dataOf<{ orderId: string }>(res).orderId;
  };
  const charge = (body: Record<string, unknown>) => ctx.http().post('/api/v1/payments/billing').set(auth()).send(body);
  const chargeBody = (orderId: string, billingKeyId: string, overrides: Record<string, unknown> = {}) => ({
    orderId,
    billingKeyId,
    amount: 29000,
    idempotencyKey: `sub-77-2026-10-${seq++}`,
    ...overrides,
  });
  const chargeRequests = () =>
    toss.requests.filter((request) => /^\/v1\/billing\/(?!authorizations)/.test(request.path));

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), TOSS_API_TIMEOUT_MS: '300' });
    service = await onboardPayableService(ctx);
    other = await onboardPayableService(ctx);
  });
  beforeEach(() =>
    toss.respond((request) => {
      if (request.path === '/v1/billing/authorizations/issue') {
        return {
          status: 200,
          body: { customerKey: request.body.customerKey, billingKey: `bk_SECRET_${seq++}`, cardCompany: '현대' },
        };
      }
      return { status: 200, body: billingPayment(request) };
    }),
  );
  afterEach(() => toss.reset());
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  it('등록된 카드로 결제 → 200 DONE, BILLING, 토스에는 복호화한 빌링키·customerKey·주문 정보·결제 단위 멱등키', async () => {
    const billingKeyId = await registerCard();
    const orderId = await createOrder();
    toss.requests.length = 0;

    const res = await charge(chargeBody(orderId, billingKeyId));

    expect(res.status).toBe(200);
    const payment = dataOf<{ paymentId: string; paymentType: string; status: string; amount: number }>(res);
    expect(payment).toMatchObject({ paymentType: 'BILLING', status: 'DONE', amount: 29000 });

    const [request] = chargeRequests();
    expect(request.path).toMatch(/^\/v1\/billing\/bk_SECRET_\d+$/);
    expect(request.body).toMatchObject({ amount: 29000, orderId, orderName: '프로 요금제 10월' });
    expect(String(request.body.customerKey)).toMatch(/^c_user-1_/);
    expect(request.headers['idempotency-key']).toBe(`billing:${payment.paymentId}`);

    const [row] = await ctx.dataSource.query<{ billing_key_id: string; provider_payment_key: string }[]>(
      'SELECT billing_key_id, provider_payment_key FROM tb_payment WHERE id = $1',
      [payment.paymentId],
    );
    expect(row).toEqual({ billing_key_id: billingKeyId, provider_payment_key: `tbill_${orderId}` });
    const [order] = await ctx.dataSource.query<{ status: string }[]>('SELECT status FROM tb_order WHERE id = $1', [
      orderId,
    ]);
    expect(order.status).toBe('PAID');
  });

  describe('멱등 — 서비스 배치의 재시도', () => {
    it('같은 idempotencyKey·같은 내용이면 토스를 다시 부르지 않고 같은 결과', async () => {
      const billingKeyId = await registerCard();
      const body = chargeBody(await createOrder(), billingKeyId);
      toss.requests.length = 0;

      const first = await charge(body);
      const again = await charge(body);

      expect(again.status).toBe(200);
      expect(dataOf<{ paymentId: string }>(again).paymentId).toBe(dataOf<{ paymentId: string }>(first).paymentId);
      expect(chargeRequests()).toHaveLength(1);
    });

    it('같은 idempotencyKey·다른 내용이면 409 PAYMENT_IDEMPOTENCY_CONFLICT', async () => {
      const billingKeyId = await registerCard();
      const body = chargeBody(await createOrder(), billingKeyId);
      await charge(body);

      const conflict = await charge({ ...body, orderId: await createOrder() });

      expect(conflict.status).toBe(409);
      expect(errorOf(conflict).code).toBe('PAYMENT_IDEMPOTENCY_CONFLICT');
    });
  });

  describe('빌링키 검증 → 404 BILLING_KEY_NOT_FOUND, 토스 호출 없음', () => {
    it.each([
      ['해제된 빌링키', 'revoked'],
      ['주문 사용자와 다른 사용자의 빌링키', 'other-user'],
      ['다른 서비스의 빌링키', 'other-service'],
    ])('%s', async (_, kind) => {
      let billingKeyId: string;
      if (kind === 'revoked') {
        billingKeyId = await registerCard();
        await ctx.http().delete(`/api/v1/billing-keys/${billingKeyId}`).set(auth());
      } else if (kind === 'other-user') {
        billingKeyId = await registerCard('user-2');
      } else {
        billingKeyId = await registerCard('user-1', other);
      }
      const orderId = await createOrder();
      toss.requests.length = 0;

      const res = await charge(chargeBody(orderId, billingKeyId));

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('BILLING_KEY_NOT_FOUND');
      expect(chargeRequests()).toHaveLength(0);
    });
  });

  it('금액이 주문과 다르면 400 PAYMENT_AMOUNT_MISMATCH', async () => {
    const res = await charge(chargeBody(await createOrder(), await registerCard(), { amount: 1 }));

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('PAYMENT_AMOUNT_MISMATCH');
  });

  it('카드 거절 → 402 PAYMENT_REJECTED, 서비스 배치는 새 idempotencyKey로 재시도할 수 있다', async () => {
    const billingKeyId = await registerCard();
    const orderId = await createOrder();
    toss.respond(() => ({ status: 403, body: { code: 'REJECT_CARD_PAYMENT', message: '잔액 부족' } }));

    const rejected = await charge(chargeBody(orderId, billingKeyId));
    expect(rejected.status).toBe(402);
    expect(errorOf(rejected).detail).toMatchObject({ pgCode: 'REJECT_CARD_PAYMENT', paymentStatus: 'FAILED' });

    toss.respond((request) => ({ status: 200, body: billingPayment(request) }));
    const retry = await charge(chargeBody(orderId, billingKeyId));
    expect(retry.status).toBe(200);
  });

  it('응답 지연 → 504 PG_TIMEOUT(UNKNOWN), 대사가 주문번호 조회로 확정하고 paymentKey를 채운다', async () => {
    const billingKeyId = await registerCard();
    const orderId = await createOrder();
    toss.respond((request) => ({ status: 200, body: billingPayment(request), delayMs: 1000 }));

    const res = await charge(chargeBody(orderId, billingKeyId));
    expect(res.status).toBe(504);
    const paymentId = errorOf(res).detail?.paymentId as string;

    toss.respond((request) => {
      if (request.path === `/v1/payments/orders/${orderId}`) {
        return { status: 200, body: billingPayment({ ...request, body: { orderId, amount: 29000 } }) };
      }
      return { status: 404, body: { code: 'NOT_FOUND_PAYMENT', message: '없음' } };
    });
    await ctx.app.get(PaymentReconciler).reconcileDue(new Date(Date.now() + 3 * 60_000));

    const [row] = await ctx.dataSource.query<{ status: string; provider_payment_key: string }[]>(
      'SELECT status, provider_payment_key FROM tb_payment WHERE id = $1',
      [paymentId],
    );
    expect(row).toEqual({ status: 'DONE', provider_payment_key: `tbill_${orderId}` });
  });
});
