import { OrderService } from '../../src/order/order.service';
import { createService, issueApiKey } from '../support/admin-fixtures';
import { IntegrationApp, adminHeaders, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface OrderData {
  orderId: string;
  externalOrderId: string;
  status: string;
  originalAmount: number;
  discountAmount: number;
  totalAmount: number;
  expiresAt: string;
  items?: { lineNo: number; productType: string; amount: number; quantity: number; canceledQuantity: number }[];
}
interface PageData<T> {
  data: T[];
  totalCount: number;
  nextCursor: string | null;
}

let seq = 0;
const orderBody = (overrides: Record<string, unknown> = {}) => ({
  externalOrderId: `order-${Date.now()}-${seq++}`,
  externalUserId: 'user-123',
  externalSubscriptionId: 'sub-77',
  orderName: '프로 요금제 1개월 외 1건',
  items: [
    {
      productType: 'PLAN',
      externalProductId: 'pro-monthly',
      productName: '프로 요금제',
      unitPrice: 29000,
      quantity: 1,
    },
    { productType: 'ADDON', externalProductId: 'storage-10g', productName: '저장공간', unitPrice: 3000, quantity: 2 },
  ],
  discountType: 'COUPON_WELCOME',
  discountAmount: 5000,
  totalAmount: 30000,
  metadata: { plan: 'pro' },
  ...overrides,
});

describe('서비스 API — 주문', () => {
  let ctx: IntegrationApp;
  let serviceA: { serviceId: string; apiKey: string };
  let serviceB: { serviceId: string; apiKey: string };

  /** 상품 유형 PLAN·ADDON(활성), CREDIT(중지)이 등록된 서비스 */
  const onboard = async () => {
    const { serviceId } = await createService(ctx);
    const base = `/api/v1/admin/services/${serviceId}/product-types`;
    for (const code of ['PLAN', 'ADDON', 'CREDIT']) {
      await ctx.http().post(base).set(adminHeaders).send({ code, name: code });
    }
    await ctx.http().patch(`${base}/CREDIT`).set(adminHeaders).send({ isActive: false });
    return { serviceId, apiKey: await issueApiKey(ctx, serviceId) };
  };

  const as = (service: { apiKey: string }) => ({
    create: (body: Record<string, unknown>) =>
      ctx.http().post('/api/v1/orders').set('Authorization', `Bearer ${service.apiKey}`).send(body),
    get: (path: string) => ctx.http().get(`/api/v1/orders${path}`).set('Authorization', `Bearer ${service.apiKey}`),
  });

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    serviceA = await onboard();
    serviceB = await onboard();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('POST /orders — 등록', () => {
    it('금액을 고정한 PENDING 주문을 만들고, 기본 만료는 30분 뒤', async () => {
      const before = Date.now();
      const res = await as(serviceA).create(orderBody());

      expect(res.status).toBe(201);
      const order = dataOf<OrderData>(res);
      expect(order).toMatchObject({
        status: 'PENDING',
        originalAmount: 35000,
        discountAmount: 5000,
        totalAmount: 30000,
      });
      expect(order.items?.map((i) => [i.lineNo, i.productType, i.amount])).toEqual([
        [1, 'PLAN', 29000],
        [2, 'ADDON', 6000],
      ]);
      const expiresIn = new Date(order.expiresAt).getTime() - before;
      expect(expiresIn).toBeGreaterThanOrEqual(1800_000 - 1000);
      expect(expiresIn).toBeLessThanOrEqual(1800_000 + 5000);
    });

    it('같은 주문번호·같은 내용으로 다시 보내면 기존 주문을 200으로 돌려준다 (멱등)', async () => {
      const body = orderBody();

      const first = await as(serviceA).create(body);
      const second = await as(serviceA).create(body);

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(dataOf<OrderData>(second).orderId).toBe(dataOf<OrderData>(first).orderId);
    });

    it('같은 주문번호로 내용이 다르면 409 ORDER_IDEMPOTENCY_CONFLICT', async () => {
      const body = orderBody();
      await as(serviceA).create(body);

      const res = await as(serviceA).create({ ...body, totalAmount: 29000, discountAmount: 6000 });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('ORDER_IDEMPOTENCY_CONFLICT');
    });

    it('같은 주문을 동시에 여러 번 보내도 주문은 하나만 생긴다', async () => {
      const body = orderBody();

      const responses = await Promise.all(Array.from({ length: 5 }, () => as(serviceA).create(body)));

      expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(new Set(responses.map((r) => dataOf<OrderData>(r).orderId)).size).toBe(1);
      const [{ count }] = await ctx.dataSource.query<{ count: string }[]>(
        'SELECT count(*) FROM tb_order WHERE service_id = $1 AND external_order_id = $2',
        [serviceA.serviceId, body.externalOrderId],
      );
      expect(Number(count)).toBe(1);
    });

    it('사전 조회와 저장 사이에 같은 주문이 먼저 저장되면(경합) 409가 아니라 기존 주문을 돌려준다', async () => {
      const body = orderBody();
      const first = dataOf<OrderData>(await as(serviceA).create(body));
      // 다른 요청이 사전 조회 직후 끼어든 상황을 결정적으로 재현: 첫 조회만 "없음"으로 보이게 한다
      const service = ctx.app.get(OrderService);
      const spy = jest
        .spyOn(service as unknown as { findByExternalOrderId: () => Promise<null> }, 'findByExternalOrderId')
        .mockResolvedValueOnce(null);

      const res = await as(serviceA).create(body);
      spy.mockRestore();

      expect(res.status).toBe(200);
      expect(dataOf<OrderData>(res).orderId).toBe(first.orderId);
    });

    it('다른 서비스는 같은 주문번호를 쓸 수 있다', async () => {
      const body = orderBody();

      const a = await as(serviceA).create(body);
      const b = await as(serviceB).create(body);

      expect([a.status, b.status]).toEqual([201, 201]);
      expect(dataOf<OrderData>(a).orderId).not.toBe(dataOf<OrderData>(b).orderId);
    });

    it('합계가 맞지 않으면 400 ORDER_AMOUNT_INVALID, detail에 계산값', async () => {
      const res = await as(serviceA).create(orderBody({ totalAmount: 31000 }));

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('ORDER_AMOUNT_INVALID');
      expect(errorOf(res).detail).toMatchObject({
        originalAmount: 35000,
        expectedTotalAmount: 30000,
        totalAmount: 31000,
      });
    });

    it('등록되지 않았거나 중지된 상품 유형은 400 PRODUCT_TYPE_NOT_ALLOWED', async () => {
      const item = (productType: string) => ({
        productType,
        externalProductId: 'x',
        productName: 'x',
        unitPrice: 1000,
        quantity: 1,
      });

      const res = await as(serviceA).create(
        orderBody({ items: [item('PLAN'), item('NOPE'), item('CREDIT')], discountAmount: 0, totalAmount: 3000 }),
      );

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('PRODUCT_TYPE_NOT_ALLOWED');
      expect(errorOf(res).detail).toEqual({ productTypes: ['CREDIT', 'NOPE'] });
    });

    it('요청 형식이 틀리면 400 INVALID_REQUEST, 필드별 메시지', async () => {
      const res = await as(serviceA).create(
        orderBody({
          items: [{ productType: 'PLAN', externalProductId: 'x', productName: 'x', unitPrice: 10.5, quantity: 0 }],
          expiresInSeconds: 10,
          currency: 'krw',
        }),
      );

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('INVALID_REQUEST');
      const fields = (errorOf(res).detail?.errors as { field: string }[]).map((e) => e.field);
      expect(fields).toEqual(
        expect.arrayContaining(['items.0.unitPrice', 'items.0.quantity', 'expiresInSeconds', 'currency']),
      );
    });

    it('API 키 없이는 401', async () => {
      const res = await ctx.http().post('/api/v1/orders').send(orderBody());

      expect(res.status).toBe(401);
    });
  });

  describe('GET /orders/:orderId', () => {
    it('자기 주문은 항목까지 돌려준다', async () => {
      const created = dataOf<OrderData>(await as(serviceA).create(orderBody()));

      const res = await as(serviceA).get(`/${created.orderId}`);

      expect(res.status).toBe(200);
      expect(dataOf<OrderData>(res)).toMatchObject({ orderId: created.orderId, totalAmount: 30000 });
      expect(dataOf<OrderData>(res).items).toHaveLength(2);
    });

    it('다른 서비스의 주문은 404 ORDER_NOT_FOUND (존재를 숨김)', async () => {
      const created = dataOf<OrderData>(await as(serviceA).create(orderBody()));

      const res = await as(serviceB).get(`/${created.orderId}`);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('ORDER_NOT_FOUND');
    });
  });

  describe('GET /orders — 목록', () => {
    it('서비스 주문번호로 찾을 수 있다', async () => {
      const body = orderBody();
      const created = dataOf<OrderData>(await as(serviceA).create(body));

      const page = dataOf<PageData<OrderData>>(await as(serviceA).get(`?externalOrderId=${body.externalOrderId}`));

      expect(page.totalCount).toBe(1);
      expect(page.data[0].orderId).toBe(created.orderId);
    });

    it('사용자별 목록은 자기 서비스 것만, 최신순 cursor 페이징', async () => {
      const userId = `user-${Date.now()}`;
      for (let i = 0; i < 3; i++) await as(serviceA).create(orderBody({ externalUserId: userId }));
      await as(serviceB).create(orderBody({ externalUserId: userId }));

      const first = dataOf<PageData<OrderData>>(await as(serviceA).get(`?externalUserId=${userId}&limit=2`));
      const second = dataOf<PageData<OrderData>>(
        await as(serviceA).get(`?externalUserId=${userId}&limit=2&cursor=${first.nextCursor}`),
      );

      expect(first.totalCount).toBe(3);
      expect(first.data).toHaveLength(2);
      expect(second.data).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const ids = [...first.data, ...second.data].map((o) => o.orderId);
      expect(new Set(ids).size).toBe(3);
    });
  });
});
