import { randomUUID } from 'crypto';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss, approvedCardPayment } from '../support/fake-toss';
import { IntegrationApp, adminHeaders, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface Row {
  serviceId: string;
  period: string;
  currency: string;
  revenue: number;
  refund: number;
  net: number;
  paymentCount: number;
  cancelCount: number;
}

let seq = 0;

describe('관리자 API — 매출·환불 리포트 GET /admin/reports/revenue', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let service: PayableService;
  let other: PayableService;

  const auth = (target: PayableService) => ({ Authorization: `Bearer ${target.apiKey}` });

  /** 토스 승인 시각을 정해 결제 → 원장의 사건 시각 = 토스 승인 시각 */
  const payAt = async (target: PayableService, amount: number, approvedAt: string): Promise<string> => {
    toss.respond((request) => ({ status: 200, body: approvedCardPayment(request, { approvedAt }) }));
    const order = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth(target))
      .send({
        externalOrderId: `rev-${Date.now()}-${seq++}`,
        externalUserId: 'user-1',
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: amount, quantity: 1 }],
        totalAmount: amount,
      });
    const res = await ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(auth(target))
      .send({ orderId: dataOf<{ orderId: string }>(order).orderId, paymentKey: `tgen_rev_${seq++}`, amount });
    return dataOf<{ paymentId: string }>(res).paymentId;
  };

  const refundAt = async (target: PayableService, paymentId: string, amount: number, canceledAt: string) => {
    toss.respond(() => ({
      status: 200,
      body: {
        status: 'PARTIAL_CANCELED',
        cancels: [{ transactionKey: `tx_${randomUUID()}`, cancelAmount: amount, canceledAt }],
      },
    }));
    await ctx
      .http()
      .post(`/api/v1/payments/${paymentId}/cancel`)
      .set(auth(target))
      .send({ amount, reasonCode: 'USER_REQUEST', idempotencyKey: `rev-refund-${seq++}` });
  };

  const report = (query: string) => ctx.http().get(`/api/v1/admin/reports/revenue${query}`).set(adminHeaders);

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start() });
    service = await onboardPayableService(ctx);
    other = await onboardPayableService(ctx);

    // KST 10월 1일 23:30 / 10월 2일 00:30 — UTC로는 둘 다 10월 1일
    const first = await payAt(service, 30000, '2026-10-01T23:30:00+09:00');
    await payAt(service, 20000, '2026-10-02T00:30:00+09:00');
    await refundAt(service, first, 10000, '2026-10-02T10:00:00+09:00');
    await payAt(service, 5000, '2026-11-01T09:00:00+09:00');
    await payAt(other, 7000, '2026-10-01T12:00:00+09:00');
  });
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  it('일별: KST 날짜 경계로 매출·환불·순매출·건수 (원장 기준)', async () => {
    const res = await report(`?serviceId=${service.serviceId}&from=2026-10-01&to=2026-10-31&groupBy=day`);

    expect(res.status).toBe(200);
    expect(dataOf<{ rows: Row[] }>(res).rows).toEqual([
      {
        serviceId: service.serviceId,
        period: '2026-10-01',
        currency: 'KRW',
        revenue: 30000,
        refund: 0,
        net: 30000,
        paymentCount: 1,
        cancelCount: 0,
      },
      {
        serviceId: service.serviceId,
        period: '2026-10-02',
        currency: 'KRW',
        revenue: 20000,
        refund: 10000,
        net: 10000,
        paymentCount: 1,
        cancelCount: 1,
      },
    ]);
  });

  it('월별 + 합계', async () => {
    const res = await report(`?serviceId=${service.serviceId}&from=2026-10-01&to=2026-11-30&groupBy=month`);
    const body = dataOf<{ rows: Row[]; totals: { currency: string; revenue: number; refund: number; net: number }[] }>(
      res,
    );

    expect(body.rows.map(({ period, revenue, refund, net }) => ({ period, revenue, refund, net }))).toEqual([
      { period: '2026-10', revenue: 50000, refund: 10000, net: 40000 },
      { period: '2026-11', revenue: 5000, refund: 0, net: 5000 },
    ]);
    expect(body.totals).toEqual([{ currency: 'KRW', revenue: 55000, refund: 10000, net: 45000 }]);
  });

  it('서비스를 지정하지 않으면 서비스별로 나눠 준다', async () => {
    const res = await report('?from=2026-10-01&to=2026-10-01&groupBy=day');
    const rows = dataOf<{ rows: Row[] }>(res).rows.filter((row) =>
      [service.serviceId, other.serviceId].includes(row.serviceId),
    );

    expect(rows.map((row) => [row.serviceId === service.serviceId ? 'service' : 'other', row.revenue]).sort()).toEqual([
      ['other', 7000],
      ['service', 30000],
    ]);
  });

  it.each([
    ['날짜 형식 오류', '?from=2026/10/01&to=2026-10-31'],
    ['from > to', '?from=2026-10-31&to=2026-10-01'],
    ['기간 1년 초과', '?from=2025-01-01&to=2026-10-31'],
    ['알 수 없는 groupBy', '?from=2026-10-01&to=2026-10-31&groupBy=week'],
  ])('%s → 400 INVALID_REQUEST', async (_, query) => {
    const res = await report(query);
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('INVALID_REQUEST');
  });
});
