import { Client } from 'pg';
import { testDbConfig } from '../setup/test-db';
import { onboardPayableService } from '../support/admin-fixtures';
import { FakeToss } from '../support/fake-toss';
import { FakeWebhookReceiver } from '../support/fake-webhook-receiver';
import { IntegrationApp, createIntegrationApp, dataOf } from '../support/integration-app';

const waitUntil = async (condition: () => boolean, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${timeoutMs}ms 안에 조건을 만족하지 못했습니다`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('웹훅 발송 스케줄러 — 앱을 띄우면 주기적으로 발송', () => {
  const toss = new FakeToss();
  const receiver = new FakeWebhookReceiver();
  let ctx: IntegrationApp;

  beforeAll(async () => {
    // 앞선 테스트 파일이 남긴 전달 대상(https://svc.example.com …)으로 외부 요청이 나가지 않게,
    // 스케줄러가 뜨기 전에 미뤄 둔다
    const client = new Client(testDbConfig());
    await client.connect();
    await client.query(
      `UPDATE tb_webhook_delivery SET next_attempt_at = now() + interval '1 day'
        WHERE status IN ('PENDING', 'RETRYING', 'PROCESSING')`,
    );
    await client.end();

    ctx = await createIntegrationApp({
      TOSS_API_BASE_URL: await toss.start(),
      WEBHOOK_DISPATCH_ENABLED: 'true',
      WEBHOOK_DISPATCH_INTERVAL_MS: '100',
    });
  });
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
    await receiver.close();
  });

  it('결제 승인 후 별도 호출 없이 서비스가 PAYMENT_CONFIRMED 웹훅을 받는다', async () => {
    const service = await onboardPayableService(ctx, { webhookUrl: await receiver.start() });
    const auth = { Authorization: `Bearer ${service.apiKey}` };
    const order = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth)
      .send({
        externalOrderId: `sched-${Date.now()}`,
        externalUserId: 'user-1',
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 1000, quantity: 1 }],
        totalAmount: 1000,
      });
    const { orderId } = dataOf<{ orderId: string }>(order);
    await ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(auth)
      .send({ orderId, paymentKey: 'tgen_sched', amount: 1000 });

    await waitUntil(() => receiver.received.length > 0, 5000);

    expect(JSON.parse(receiver.received[0].rawBody)).toMatchObject({
      eventType: 'PAYMENT_CONFIRMED',
      data: { orderId },
    });
  });
});
