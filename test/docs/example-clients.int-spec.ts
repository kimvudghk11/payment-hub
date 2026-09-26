import { AddressInfo } from 'net';
import { PaymentHubAdminClient } from '../../examples/admin-client';
import { PaymentHubError } from '../../examples/http';
import { PaymentHubServiceClient } from '../../examples/service-client';
import { FakeToss, canceledPayment } from '../support/fake-toss';
import { ADMIN_KEY, IntegrationApp, createIntegrationApp, uniqueServiceCode } from '../support/integration-app';

/**
 * 연동 가이드가 싣는 예제 클라이언트(examples/)를 실제 HTTP로 띄운 hub에 붙여 검증한다.
 * 가이드의 "온보딩 → 연결 확인 → 주문 등록" 흐름을 그대로 따라간다.
 */
describe('연동 예제 클라이언트 (examples/) — 실제 hub에 연결', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let admin: PaymentHubAdminClient;
  let baseUrl: string;
  const actor = { actorId: 'admin-7', actorName: '홍길동', requestId: 'req-example' };

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), EVENT_FEED_LAG_MS: '0' });
    await ctx.app.listen(0, '127.0.0.1');
    const server = ctx.app.getHttpServer() as unknown as { address(): AddressInfo };
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    admin = new PaymentHubAdminClient({ baseUrl, adminKey: ADMIN_KEY });
  });

  afterEach(() => toss.reset());
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  /** admin 가이드의 온보딩 절차 */
  const onboard = async () => {
    const service = await admin.createService(actor, { code: uniqueServiceCode(), name: '예제 서비스' });
    await admin.createProductType(actor, service.serviceId, { code: 'PLAN', name: '구독 요금제' });
    await admin.registerPgCredential(actor, service.serviceId, {
      environment: 'TEST',
      clientKey: 'test_ck_example',
      secretKey: 'test_sk_example',
    });
    const { apiKey } = await admin.issueApiKey(actor, service.serviceId, { label: 'example' });
    return { service, apiKey };
  };

  const orderInput = (externalOrderId: string) => ({
    externalOrderId,
    externalUserId: 'user-1',
    orderName: '구독 1개월',
    items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 10000, quantity: 1 }],
    totalAmount: 10000,
  });

  it('admin 클라이언트로 온보딩하고, 받은 API 키로 서비스 클라이언트가 연결된다', async () => {
    const { service, apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });

    expect(service.webhookSecret).toMatch(/^whsec_/);
    expect(await client.me()).toMatchObject({ serviceId: service.serviceId, status: 'ACTIVE' });
    expect(await client.getPgClientConfig()).toEqual({
      provider: 'TOSS',
      environment: 'TEST',
      clientKey: 'test_ck_example',
    });
  });

  it('주문 등록 → 재시도 → 조회 흐름', async () => {
    const { apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });

    const first = await client.createOrder(orderInput('ex-order-1'));
    const retry = await client.createOrder(orderInput('ex-order-1'));
    const fetched = await client.getOrder(first.order.orderId);
    const page = await client.listOrders({ externalOrderId: 'ex-order-1' });

    expect(first.created).toBe(true);
    expect(retry).toMatchObject({ created: false, order: { orderId: first.order.orderId } });
    expect(fetched.items).toHaveLength(1);
    expect(page.data.map((o) => o.orderId)).toEqual([first.order.orderId]);
  });

  it('주문 등록 → 결제 승인 → 결제 조회·사용자별 이력·환불 가능 금액', async () => {
    const { apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });
    const { order } = await client.createOrder(orderInput('ex-pay-1'));

    // 토스 successUrl로 받은 값을 그대로 전달
    const payment = await client.confirmPayment({ orderId: order.orderId, paymentKey: 'tgen_ex_1', amount: 10000 });
    const again = await client.confirmPayment({ orderId: order.orderId, paymentKey: 'tgen_ex_1', amount: 10000 });
    const history = await client.listPayments({ externalUserId: 'user-1', status: ['DONE', 'PARTIAL_CANCELED'] });
    const refundable = await client.getRefundable(payment.paymentId);

    expect(payment).toMatchObject({ status: 'DONE', amount: 10000, method: { type: 'CARD', cardType: 'CREDIT' } });
    expect(again.paymentId).toBe(payment.paymentId);
    expect(await client.getPayment(payment.paymentId)).toMatchObject({ externalOrderId: 'ex-pay-1' });
    expect(history.data.map((p) => p.paymentId)).toEqual([payment.paymentId]);
    expect(refundable).toMatchObject({ refundableAmount: 10000, items: [{ cancelableQuantity: 1 }] });
  });

  it('환불: 환불 가능 금액 확인 → 부분 환불 → 같은 멱등키 재시도는 같은 결과', async () => {
    const { apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });
    const { order } = await client.createOrder(orderInput('ex-refund-1'));
    const payment = await client.confirmPayment({ orderId: order.orderId, paymentKey: 'tgen_ex_r1', amount: 10000 });
    toss.respond((request) => ({ status: 200, body: canceledPayment(request) }));

    const { refundableAmount, items } = await client.getRefundable(payment.paymentId);
    const input = {
      amount: 4000,
      reasonCode: 'USER_REQUEST',
      reasonDetail: '일할 환불',
      idempotencyKey: 'ex-refund-1-first',
      items: [{ orderItemId: items[0].orderItemId, quantity: 1, amount: 4000 }],
    };
    const refunded = await client.cancelPayment(payment.paymentId, input);
    const retried = await client.cancelPayment(payment.paymentId, input);

    expect(refundableAmount).toBe(10000);
    expect(refunded).toMatchObject({
      cancel: { status: 'DONE', amount: 4000 },
      payment: { status: 'PARTIAL_CANCELED', refundableAmount: 6000 },
    });
    expect(retried.cancel.paymentCancelId).toBe(refunded.cancel.paymentCancelId);
    expect((await client.getPayment(payment.paymentId)).cancels).toHaveLength(1);
  });

  it('admin: 토스 paymentKey로 결제를 찾고 상세(원장·웹훅 전달 내역)를 본다', async () => {
    const { service, apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });
    const { order } = await client.createOrder(orderInput('ex-admin-pay-1'));
    const payment = await client.confirmPayment({
      orderId: order.orderId,
      paymentKey: 'tgen_ex_admin_1',
      amount: 10000,
    });

    const found = await admin.searchPayments(actor, { paymentKey: 'tgen_ex_admin_1' });
    const detail = await admin.getPayment(actor, payment.paymentId);

    expect(found.data.map((p) => p.paymentId)).toEqual([payment.paymentId]);
    expect(found.data[0].serviceId).toBe(service.serviceId);
    expect(detail.ledger.map((tx) => tx.transactionType)).toEqual(['PAYMENT_CAPTURED']);
    expect(detail.order.items).toHaveLength(1);
  });

  it('admin 운영: 실패 웹훅 조회 → 재전송, 대사 대기 결제 조회 → 수동 대사', async () => {
    const { service, apiKey } = await onboard();
    await admin.updateService(actor, service.serviceId, { webhookUrl: 'https://svc.example.com/hook' });
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });
    const { order } = await client.createOrder(orderInput('ex-ops-1'));
    const payment = await client.confirmPayment({ orderId: order.orderId, paymentKey: 'tgen_ex_ops_1', amount: 10000 });
    await ctx.dataSource.query(
      `UPDATE tb_webhook_delivery d SET status = 'DEAD' FROM tb_outbox_event e
        WHERE e.id = d.event_id AND e.aggregate_id = $1`,
      [payment.paymentId],
    );

    const dead = await admin.listWebhookDeliveries(actor, { status: 'DEAD', serviceId: service.serviceId });
    const redelivered = await admin.redeliverWebhook(actor, dead.data[0].webhookDeliveryId, '서비스 장애 복구 후');
    const unknown = await admin.listUnknownPayments(actor, { serviceId: service.serviceId });
    const reconciled = await admin.reconcilePayment(actor, payment.paymentId);

    expect(dead.data.map((d) => d.eventType)).toEqual(['PAYMENT_CONFIRMED']);
    expect(redelivered.status).toBe('PENDING');
    expect(unknown.data).toEqual([]);
    expect(reconciled).toMatchObject({ resolved: false, payment: { status: 'DONE' } });
  });

  it('admin 수동 환불: 사유 필수, 결과는 결제 상세의 취소 이력에 requestedBy=ADMIN으로', async () => {
    const { apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });
    const { order } = await client.createOrder(orderInput('ex-admin-refund-1'));
    const payment = await client.confirmPayment({
      orderId: order.orderId,
      paymentKey: 'tgen_ex_admr_1',
      amount: 10000,
    });
    toss.respond((request) => ({ status: 200, body: canceledPayment(request) }));

    const noReason = await admin
      .cancelPayment(actor, payment.paymentId, { amount: 10000, reasonCode: 'CS_REFUND', idempotencyKey: 'cs-1' })
      .catch((e: unknown) => e);
    const refunded = await admin.cancelPayment(actor, payment.paymentId, {
      amount: 10000,
      reasonCode: 'CS_REFUND',
      reason: '고객 요청 전액 환불',
      idempotencyKey: 'cs-1',
    });

    expect(noReason).toMatchObject({ status: 400, code: 'ADMIN_REASON_REQUIRED' });
    expect(refunded).toMatchObject({ cancel: { requestedBy: 'ADMIN' }, payment: { status: 'CANCELED' } });
    expect((await admin.getPayment(actor, payment.paymentId)).cancels.map((c) => c.requestedBy)).toEqual(['ADMIN']);
  });

  it('놓친 웹훅 따라잡기: 마지막으로 처리한 eventId부터 이벤트를 끝까지 읽는다', async () => {
    const { apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });
    for (const id of ['ex-feed-1', 'ex-feed-2']) {
      const { order } = await client.createOrder(orderInput(id));
      await client.confirmPayment({ orderId: order.orderId, paymentKey: `tgen_${id}`, amount: 10000 });
    }

    const handled: string[] = [];
    const last = await client.catchUpEvents(undefined, (event) => {
      handled.push(event.eventType);
      return Promise.resolve();
    });

    expect(handled).toEqual(['PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED']);
    // 다음 실행: 저장해 둔 마지막 eventId부터 → 새 이벤트 없음
    expect(await client.catchUpEvents(last, () => Promise.reject(new Error('새 이벤트 없음')))).toBe(last);
  });

  it('결제 수단: 카드 등록 → 사용자 목록 → 해제', async () => {
    const { apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });
    toss.respond((request) => ({
      status: 200,
      body: {
        customerKey: request.body.customerKey,
        billingKey: 'bk_secret',
        cardCompany: '신한',
        cardNumber: '9410****',
      },
    }));

    const key = await client.issueBillingKey({ externalUserId: 'user-1', customerKey: 'c_user1_x', authKey: 'bln_1' });
    const listed = await client.listBillingKeys('user-1');
    const revoked = await client.revokeBillingKey(key.billingKeyId);

    expect(key).toMatchObject({ cardCompany: '신한', status: 'ACTIVE' });
    expect(listed.data.map((k) => k.billingKeyId)).toEqual([key.billingKeyId]);
    expect(revoked.status).toBe('REVOKED');
    expect(await client.listBillingKeys('user-1')).toMatchObject({ data: [] });
  });

  it('정기결제: 카드 등록 → (배치) 주문 등록 → 자동결제, 재시도는 같은 멱등키로 같은 결과', async () => {
    const { apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });
    toss.respond((request) =>
      request.path === '/v1/billing/authorizations/issue'
        ? { status: 200, body: { customerKey: request.body.customerKey, billingKey: 'bk_secret', cardCompany: '신한' } }
        : {
            status: 200,
            body: {
              paymentKey: `tbill_${String(request.body.orderId)}`,
              orderId: request.body.orderId,
              status: 'DONE',
              method: '카드',
              totalAmount: request.body.amount,
              currency: 'KRW',
              approvedAt: '2026-10-01T09:00:00+09:00',
              card: { issuerCode: '41', number: '9410****', installmentPlanMonths: 0, cardType: '신용' },
            },
          },
    );
    const card = await client.issueBillingKey({
      externalUserId: 'user-1',
      customerKey: 'c_user1_sub',
      authKey: 'bln_2',
    });

    const { order } = await client.createOrder(orderInput('ex-sub-77-2026-10'));
    const input = {
      orderId: order.orderId,
      billingKeyId: card.billingKeyId,
      amount: 10000,
      idempotencyKey: 'sub-77-2026-10',
    };
    const paid = await client.chargeBilling(input);
    const retried = await client.chargeBilling(input);

    expect(paid).toMatchObject({ paymentType: 'BILLING', status: 'DONE', method: { type: 'CARD' } });
    expect(retried.paymentId).toBe(paid.paymentId);
  });

  it('토스 거절은 PaymentHubError(402 PAYMENT_REJECTED) + detail.pgMessage로 사용자에게 사유를 보여줄 수 있다', async () => {
    const { apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });
    const { order } = await client.createOrder(orderInput('ex-pay-2'));
    toss.respond(() => ({ status: 403, body: { code: 'REJECT_CARD_PAYMENT', message: '한도초과 혹은 잔액부족' } }));

    const error = await client
      .confirmPayment({ orderId: order.orderId, paymentKey: 'tgen_ex_2', amount: 10000 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaymentHubError);
    expect(error).toMatchObject({
      status: 402,
      code: 'PAYMENT_REJECTED',
      detail: { pgCode: 'REJECT_CARD_PAYMENT', pgMessage: '한도초과 혹은 잔액부족' },
    });
  });

  it('실패는 PaymentHubError(status, code, detail)로 받아 code로 분기할 수 있다', async () => {
    const { apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });

    const error = await client.createOrder({ ...orderInput('ex-bad'), totalAmount: 9999 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaymentHubError);
    expect(error).toMatchObject({
      status: 400,
      code: 'ORDER_AMOUNT_INVALID',
      detail: { expectedTotalAmount: 10000, totalAmount: 9999 },
    });
  });

  it('admin이 서비스를 정지하면 서비스 클라이언트는 SERVICE_SUSPENDED를 받는다', async () => {
    const { service, apiKey } = await onboard();
    const client = new PaymentHubServiceClient({ baseUrl, apiKey });

    await admin.suspendService(actor, service.serviceId, '예제: 정지 확인');
    const error = await client.me().catch((e: unknown) => e);
    await admin.resumeService(actor, service.serviceId);

    expect(error).toMatchObject({ status: 403, code: 'SERVICE_SUSPENDED' });
    expect((await client.me()).status).toBe('ACTIVE');
  });

  it('키 교체 절차: 새 키 발급 → 새 키로 전환 → 구 키 폐기', async () => {
    const { service, apiKey: oldKey } = await onboard();

    const { apiKey: newKey } = await admin.issueApiKey(actor, service.serviceId, { label: 'rotated' });
    await new PaymentHubServiceClient({ baseUrl, apiKey: newKey }).me();
    const keys = await admin.listApiKeys(actor, service.serviceId);
    const old = keys.find((k) => k.label === 'example');
    await admin.revokeApiKey(actor, old!.apiKeyId);

    const error = await new PaymentHubServiceClient({ baseUrl, apiKey: oldKey }).me().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, code: 'API_KEY_REVOKED' });
    expect((await new PaymentHubServiceClient({ baseUrl, apiKey: newKey }).me()).serviceId).toBe(service.serviceId);
  });
});
