import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss, approvedCardPayment } from '../support/fake-toss';
import { IntegrationApp, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface PaymentData {
  paymentId: string;
  orderId: string;
  externalOrderId: string;
  externalUserId: string;
  status: string;
  method: { type: string | null };
}
interface PageData<T> {
  data: T[];
  totalCount: number;
  nextCursor: string | null;
}
interface RefundableData {
  paymentId: string;
  status: string;
  amount: number;
  refundedAmount: number;
  refundableAmount: number;
  items: {
    orderItemId: string;
    productName: string;
    quantity: number;
    canceledQuantity: number;
    cancelableQuantity: number;
  }[];
}

let seq = 0;

describe('서비스 API — 결제 조회', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let serviceA: PayableService;
  let serviceB: PayableService;

  const get = (path: string, service: PayableService = serviceA) =>
    ctx.http().get(`/api/v1/payments${path}`).set('Authorization', `Bearer ${service.apiKey}`);

  /** 주문 등록 → 승인. 토스 응답은 toss.respond로 미리 정한다 */
  const pay = async (
    service: PayableService,
    externalUserId: string,
    items = [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 30000, quantity: 1 }],
  ): Promise<PaymentData & { status: string }> => {
    const auth = { Authorization: `Bearer ${service.apiKey}` };
    const totalAmount = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const order = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth)
      .send({
        externalOrderId: `q-order-${Date.now()}-${seq++}`,
        externalUserId,
        orderName: '결제',
        items,
        totalAmount,
      });
    const { orderId } = dataOf<{ orderId: string }>(order);
    const res = await ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(auth)
      .send({ orderId, paymentKey: `tgen_q_${Date.now()}_${seq++}`, amount: totalAmount });
    if (res.status === 200) return dataOf<PaymentData>(res);
    const paymentId = errorOf(res).detail?.paymentId as string;
    return { paymentId, orderId, status: 'FAILED' } as PaymentData;
  };

  const rejectNext = () =>
    toss.respond(() => ({ status: 403, body: { code: 'REJECT_CARD_PAYMENT', message: '한도초과' } }));

  let userAPayments: PaymentData[];
  let failedPayment: PaymentData;
  let virtualAccountPayment: PaymentData;

  beforeAll(async () => {
    const baseUrl = await toss.start();
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: baseUrl, TOSS_API_TIMEOUT_MS: '300' });
    serviceA = await onboardPayableService(ctx);
    serviceB = await onboardPayableService(ctx);

    const card1 = await pay(serviceA, 'user-a');
    rejectNext();
    failedPayment = await pay(serviceA, 'user-a');
    toss.respond((request) => ({
      status: 200,
      body: approvedCardPayment(request, {
        status: 'WAITING_FOR_DEPOSIT',
        method: '가상계좌',
        approvedAt: null,
        card: null,
        virtualAccount: { accountNumber: 'X1', bankCode: '20', dueDate: '2026-09-28T23:59:59+09:00' },
      }),
    }));
    virtualAccountPayment = await pay(serviceA, 'user-a');
    toss.reset();
    const card2 = await pay(serviceA, 'user-a');
    userAPayments = [card1, failedPayment, virtualAccountPayment, card2];

    await pay(serviceA, 'user-b');
    await pay(serviceB, 'user-a'); // 다른 서비스의 같은 사용자 ID
  });
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  describe('GET /payments/:paymentId', () => {
    it('결제 + 서비스 주문 연결 정보, PG 응답 원본은 주지 않는다', async () => {
      const [card] = userAPayments;
      const res = await get(`/${card.paymentId}`);

      expect(res.status).toBe(200);
      const payment = dataOf<PaymentData & Record<string, unknown>>(res);
      expect(payment).toMatchObject({
        paymentId: card.paymentId,
        orderId: card.orderId,
        externalUserId: 'user-a',
        status: 'DONE',
        refundableAmount: 30000,
        method: { type: 'CARD' },
      });
      expect(payment).not.toHaveProperty('providerResponse');
      expect(JSON.stringify(payment)).not.toContain('balanceAmount');
    });

    it('실패한 결제는 토스 원본 사유를 준다', async () => {
      const res = await get(`/${failedPayment.paymentId}`);

      expect(dataOf<Record<string, unknown>>(res)).toMatchObject({
        status: 'FAILED',
        refundableAmount: 0,
        failure: { code: 'REJECT_CARD_PAYMENT', message: '한도초과' },
      });
    });

    it('다른 서비스의 결제는 404 PAYMENT_NOT_FOUND (존재 숨김)', async () => {
      const res = await get(`/${userAPayments[0].paymentId}`, serviceB);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PAYMENT_NOT_FOUND');
    });
  });

  describe('GET /payments — 사용자별 결제 이력', () => {
    it('서비스 + 사용자 단위로, 실패한 시도까지 최신순', async () => {
      const res = await get('?externalUserId=user-a');

      expect(res.status).toBe(200);
      const page = dataOf<PageData<PaymentData>>(res);
      expect(page.totalCount).toBe(4);
      expect(page.data.map((payment) => payment.paymentId)).toEqual(
        [...userAPayments].reverse().map((payment) => payment.paymentId),
      );
      expect(page.data.every((payment) => payment.externalUserId === 'user-a')).toBe(true);
    });

    it('다른 서비스의 같은 사용자 ID 결제는 섞이지 않는다', async () => {
      const page = dataOf<PageData<PaymentData>>(await get('?externalUserId=user-a', serviceB));
      expect(page.totalCount).toBe(1);
    });

    it('상태는 쉼표로 여러 개, 결제 수단 분류로도 거른다', async () => {
      const byStatus = dataOf<PageData<PaymentData>>(
        await get('?externalUserId=user-a&status=DONE,WAITING_FOR_DEPOSIT'),
      );
      expect(byStatus.data.map((payment) => payment.status).sort()).toEqual(['DONE', 'DONE', 'WAITING_FOR_DEPOSIT']);

      const byMethod = dataOf<PageData<PaymentData>>(await get('?externalUserId=user-a&methodType=VIRTUAL_ACCOUNT'));
      expect(byMethod.data.map((payment) => payment.paymentId)).toEqual([virtualAccountPayment.paymentId]);
    });

    it('서비스 주문번호로 찾는다', async () => {
      const { externalOrderId } = dataOf<PaymentData>(await get(`/${userAPayments[0].paymentId}`));
      const page = dataOf<PageData<PaymentData>>(await get(`?externalOrderId=${externalOrderId}`));

      expect(page.data.map((payment) => payment.paymentId)).toEqual([userAPayments[0].paymentId]);
    });

    it('cursor 페이징 — 다음 페이지로 이어서 빠짐없이', async () => {
      const first = dataOf<PageData<PaymentData>>(await get('?externalUserId=user-a&limit=3'));
      const second = dataOf<PageData<PaymentData>>(
        await get(`?externalUserId=user-a&limit=3&cursor=${encodeURIComponent(first.nextCursor ?? '')}`),
      );

      expect(first.data).toHaveLength(3);
      expect(second.data).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect([...first.data, ...second.data].map((payment) => payment.paymentId)).toEqual(
        [...userAPayments].reverse().map((payment) => payment.paymentId),
      );
    });

    it('알 수 없는 상태 값은 400 INVALID_REQUEST', async () => {
      const res = await get('?status=DONE,PAID');

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('INVALID_REQUEST');
    });
  });

  describe('GET /payments/:paymentId/refundable — 환불 가능 금액', () => {
    it('승인된 결제: 금액·환불 누적·환불 가능 금액과 항목별 취소 가능 수량', async () => {
      const payment = await pay(serviceA, 'user-c', [
        { productType: 'PLAN', externalProductId: 'pro', productName: '프로 요금제', unitPrice: 29000, quantity: 1 },
        { productType: 'PLAN', externalProductId: 'storage', productName: '저장공간', unitPrice: 3000, quantity: 2 },
      ]);
      const res = await get(`/${payment.paymentId}/refundable`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ message: '환불 가능 금액을 조회했습니다.' });
      const refundable = dataOf<RefundableData>(res);
      expect(refundable).toMatchObject({
        paymentId: payment.paymentId,
        status: 'DONE',
        amount: 35000,
        refundedAmount: 0,
        refundableAmount: 35000,
      });
      expect(
        refundable.items.map(({ productName, quantity, canceledQuantity, cancelableQuantity }) => ({
          productName,
          quantity,
          canceledQuantity,
          cancelableQuantity,
        })),
      ).toEqual([
        { productName: '프로 요금제', quantity: 1, canceledQuantity: 0, cancelableQuantity: 1 },
        { productName: '저장공간', quantity: 2, canceledQuantity: 0, cancelableQuantity: 2 },
      ]);
    });

    it('승인되지 않은 결제(실패·입금 대기)는 환불 가능 금액·수량 0', async () => {
      for (const payment of [failedPayment, virtualAccountPayment]) {
        const refundable = dataOf<RefundableData>(await get(`/${payment.paymentId}/refundable`));
        expect(refundable.refundableAmount).toBe(0);
        expect(refundable.items.every((item) => item.cancelableQuantity === 0)).toBe(true);
      }
    });

    it('다른 서비스의 결제는 404 PAYMENT_NOT_FOUND', async () => {
      const res = await get(`/${userAPayments[0].paymentId}/refundable`, serviceB);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PAYMENT_NOT_FOUND');
    });
  });
});
