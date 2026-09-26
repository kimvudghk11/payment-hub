import { EventFeedService } from '../../src/outbox/event-feed.service';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss } from '../support/fake-toss';
import { IntegrationApp, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface FeedEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  data: Record<string, unknown>;
}
interface Page {
  data: FeedEvent[];
  totalCount: number;
  nextCursor: string | null;
}

let seq = 0;

describe('서비스 API — 이벤트 재조회 GET /events', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let service: PayableService;
  let other: PayableService;

  const events = (query: string, target: PayableService = service) =>
    ctx.http().get(`/api/v1/events${query}`).set('Authorization', `Bearer ${target.apiKey}`);

  const pay = async (target: PayableService): Promise<string> => {
    const auth = { Authorization: `Bearer ${target.apiKey}` };
    const order = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth)
      .send({
        externalOrderId: `feed-${Date.now()}-${seq++}`,
        externalUserId: 'user-1',
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 1000, quantity: 1 }],
        totalAmount: 1000,
      });
    const res = await ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(auth)
      .send({ orderId: dataOf<{ orderId: string }>(order).orderId, paymentKey: `tgen_feed_${seq++}`, amount: 1000 });
    return dataOf<{ paymentId: string }>(res).paymentId;
  };

  let paymentIds: string[];

  beforeAll(async () => {
    // 재조회는 발행 후 잠깐(기본 5초) 지난 이벤트부터 준다 — 테스트는 0으로 두고 지연은 서비스 단위 테스트에서 본다
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), EVENT_FEED_LAG_MS: '0' });
    service = await onboardPayableService(ctx);
    other = await onboardPayableService(ctx);
    paymentIds = [];
    for (let i = 0; i < 3; i++) paymentIds.push(await pay(service));
    await pay(other);
  });
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  it('처음부터: 자기 서비스 이벤트만 발행 순서대로, 웹훅과 같은 형태', async () => {
    const res = await events('');

    expect(res.status).toBe(200);
    const page = dataOf<Page>(res);
    expect(page.data.map((event) => event.data.paymentId)).toEqual(paymentIds);
    expect(page.data[0]).toMatchObject({
      eventType: 'PAYMENT_CONFIRMED',
      data: { status: 'DONE', amount: 1000 },
    });
    expect(page.totalCount).toBe(3);
  });

  it('after=<마지막으로 처리한 eventId>부터 이어서, limit만큼 + nextCursor', async () => {
    const all = dataOf<Page>(await events('')).data;

    const first = dataOf<Page>(await events(`?after=${all[0].eventId}&limit=1`));
    const second = dataOf<Page>(await events(`?after=${first.nextCursor}&limit=1`));

    expect(first.data.map((event) => event.eventId)).toEqual([all[1].eventId]);
    expect(first.totalCount).toBe(2);
    expect(first.nextCursor).toBe(all[1].eventId);
    expect(second.data.map((event) => event.eventId)).toEqual([all[2].eventId]);
    expect(second.nextCursor).toBeNull();
  });

  it('다른 서비스의 eventId를 after로 주면 404 RESOURCE_NOT_FOUND (존재 숨김)', async () => {
    const otherEvent = dataOf<Page>(await events('', other)).data[0];
    const res = await events(`?after=${otherEvent.eventId}`);

    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('발행 직후 지연 시간 안의 이벤트는 아직 주지 않는다 (늦게 커밋되는 이벤트를 건너뛰지 않게)', async () => {
    const feed = ctx.app.get(EventFeedService);
    const page = await feed.list(service.serviceId, {}, new Date(Date.now() - 60_000), 5_000);
    expect(page.data).toEqual([]);
  });
});
