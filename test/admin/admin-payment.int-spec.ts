import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss, approvedCardPayment, canceledPayment } from '../support/fake-toss';
import { IntegrationApp, adminHeaders, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface AdminPayment {
  paymentId: string;
  serviceId: string;
  providerPaymentKey: string | null;
  externalUserId: string;
  status: string;
  method: { type: string | null; cardCompanyCode: string | null };
}
interface Page<T> {
  data: T[];
  totalCount: number;
  nextCursor: string | null;
}
interface AdminPaymentDetail extends AdminPayment {
  order: { orderId: string; status: string; items: { productName: string; canceledQuantity: number }[] };
  cancels: { status: string; amount: number; requestedBy: string }[];
  ledger: {
    transactionType: string;
    referenceType: string;
    entries: { accountCode: string; direction: string; amount: number }[];
  }[];
  webhookDeliveries: { eventType: string; status: string; attemptCount: number; targetUrl: string }[];
  providerResponse: Record<string, unknown> | null;
}

let seq = 0;

describe('관리자 API — 결제 조회', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let serviceA: PayableService;
  let serviceB: PayableService;
  const paymentKeys: string[] = [];

  const pay = async (service: PayableService, externalUserId: string): Promise<string> => {
    const auth = { Authorization: `Bearer ${service.apiKey}` };
    const order = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth)
      .send({
        externalOrderId: `adm-order-${Date.now()}-${seq++}`,
        externalUserId,
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 30000, quantity: 1 }],
        totalAmount: 30000,
      });
    const paymentKey = `tgen_adm_${seq++}`;
    paymentKeys.push(paymentKey);
    const res = await ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(auth)
      .send({ orderId: dataOf<{ orderId: string }>(order).orderId, paymentKey, amount: 30000 });
    return (dataOf<{ paymentId?: string }>(res)?.paymentId ?? errorOf(res).detail?.paymentId) as string;
  };

  const get = (path: string) => ctx.http().get(`/api/v1/admin/payments${path}`).set(adminHeaders);

  let refundedPaymentId: string;
  let failedPaymentId: string;

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start() });
    serviceA = await onboardPayableService(ctx);
    serviceB = await onboardPayableService(ctx);

    refundedPaymentId = await pay(serviceA, 'user-a');
    toss.respond(() => ({ status: 403, body: { code: 'REJECT_CARD_PAYMENT', message: '한도초과' } }));
    failedPaymentId = await pay(serviceA, 'user-a');
    toss.reset();
    await pay(serviceB, 'user-b');

    toss.respond((request) => ({
      status: 200,
      body: request.path.endsWith('/cancel') ? canceledPayment(request) : approvedCardPayment(request),
    }));
    await ctx
      .http()
      .post(`/api/v1/payments/${refundedPaymentId}/cancel`)
      .set('Authorization', `Bearer ${serviceA.apiKey}`)
      .send({ amount: 5000, reasonCode: 'USER_REQUEST', idempotencyKey: `adm-refund-${seq++}` });
    toss.reset();
  });
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  describe('GET /admin/payments — 전 서비스 검색', () => {
    it('모든 서비스의 결제를 최신순으로, 서비스 ID·토스 paymentKey와 함께', async () => {
      const res = await get('?limit=100');

      expect(res.status).toBe(200);
      const page = dataOf<Page<AdminPayment>>(res);
      const serviceIds = new Set(page.data.map((payment) => payment.serviceId));
      expect(serviceIds.has(serviceA.serviceId) && serviceIds.has(serviceB.serviceId)).toBe(true);
      expect(page.data.find((payment) => payment.paymentId === refundedPaymentId)?.providerPaymentKey).toBe(
        paymentKeys[0],
      );
    });

    it('서비스·상태(쉼표 여러 개)·사용자로 거른다', async () => {
      const page = dataOf<Page<AdminPayment>>(
        await get(`?serviceId=${serviceA.serviceId}&status=FAILED,PARTIAL_CANCELED&externalUserId=user-a`),
      );

      expect(page.data.map((payment) => payment.paymentId).sort()).toEqual([refundedPaymentId, failedPaymentId].sort());
    });

    it('토스 paymentKey로 찾는다 (토스 대시보드·CS 문의에서 넘어온 키)', async () => {
      const page = dataOf<Page<AdminPayment>>(await get(`?paymentKey=${paymentKeys[2]}`));

      expect(page.data).toHaveLength(1);
      expect(page.data[0].serviceId).toBe(serviceB.serviceId);
    });

    it('결제 수단·카드사로 거른다', async () => {
      const page = dataOf<Page<AdminPayment>>(
        await get(`?serviceId=${serviceA.serviceId}&methodType=CARD&cardCompanyCode=11`),
      );

      expect(page.data.map((payment) => payment.paymentId)).toEqual([refundedPaymentId]);
    });

    it('서비스 API 키로는 호출할 수 없다 (401)', async () => {
      const res = await ctx.http().get('/api/v1/admin/payments').set('Authorization', `Bearer ${serviceA.apiKey}`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /admin/payments/:paymentId — 상세', () => {
    it('주문·항목, 취소 이력, 원장 분개, 웹훅 전달 내역, PG 응답 원본을 한 번에', async () => {
      const res = await get(`/${refundedPaymentId}`);

      expect(res.status).toBe(200);
      const detail = dataOf<AdminPaymentDetail>(res);
      expect(detail).toMatchObject({
        paymentId: refundedPaymentId,
        serviceId: serviceA.serviceId,
        status: 'PARTIAL_CANCELED',
        order: { status: 'PARTIAL_CANCELED', items: [{ productName: '프로', canceledQuantity: 0 }] },
        cancels: [{ status: 'DONE', amount: 5000, requestedBy: 'SERVICE' }],
      });
      expect(detail.ledger).toEqual([
        {
          transactionType: 'PAYMENT_CAPTURED',
          referenceType: 'PAYMENT',
          occurredAt: expect.any(String) as unknown,
          entries: [
            { accountCode: 'PG_RECEIVABLE', direction: 'DEBIT', amount: 30000 },
            { accountCode: 'REVENUE', direction: 'CREDIT', amount: 30000 },
          ],
        },
        {
          transactionType: 'PAYMENT_CANCELED',
          referenceType: 'PAYMENT_CANCEL',
          occurredAt: expect.any(String) as unknown,
          entries: [
            { accountCode: 'REFUND', direction: 'DEBIT', amount: 5000 },
            { accountCode: 'PG_RECEIVABLE', direction: 'CREDIT', amount: 5000 },
          ],
        },
      ]);
      expect(detail.webhookDeliveries.map((delivery) => delivery.eventType)).toEqual([
        'PAYMENT_CONFIRMED',
        'PAYMENT_CANCELED',
      ]);
      expect(detail.webhookDeliveries[0]).toMatchObject({ status: 'PENDING', attemptCount: 0 });
      expect(detail.providerResponse).toMatchObject({ paymentKey: paymentKeys[0], status: 'DONE' });
    });

    it('실패한 결제는 토스 원본 실패 응답을 본다', async () => {
      const detail = dataOf<AdminPaymentDetail>(await get(`/${failedPaymentId}`));

      expect(detail.providerResponse).toEqual({ code: 'REJECT_CARD_PAYMENT', message: '한도초과' });
      expect(detail.ledger).toEqual([]);
    });

    it('없는 결제는 404 PAYMENT_NOT_FOUND', async () => {
      const res = await get('/00000000-0000-4000-8000-000000000000');

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PAYMENT_NOT_FOUND');
    });
  });
});
