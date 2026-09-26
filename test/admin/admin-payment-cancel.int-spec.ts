import { PayableService, auditActionsOf, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss, approvedCardPayment, canceledPayment } from '../support/fake-toss';
import { IntegrationApp, adminHeaders, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface CancelResult {
  cancel: { paymentCancelId: string; status: string; amount: number; requestedBy: string; reasonDetail: string };
  payment: { paymentId: string; serviceId: string; status: string; refundableAmount: number };
}

let seq = 0;

describe('관리자 API — 수동 환불 POST /admin/payments/:paymentId/cancel', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let service: PayableService;

  const paid = async (): Promise<string> => {
    const auth = { Authorization: `Bearer ${service.apiKey}` };
    const order = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth)
      .send({
        externalOrderId: `adm-cancel-${Date.now()}-${seq++}`,
        externalUserId: 'user-1',
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 30000, quantity: 1 }],
        totalAmount: 30000,
      });
    const res = await ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(auth)
      .send({ orderId: dataOf<{ orderId: string }>(order).orderId, paymentKey: `tgen_admc_${seq++}`, amount: 30000 });
    toss.requests.length = 0;
    return dataOf<{ paymentId: string }>(res).paymentId;
  };

  const adminCancel = (paymentId: string, body: Record<string, unknown>) =>
    ctx.http().post(`/api/v1/admin/payments/${paymentId}/cancel`).set(adminHeaders).send(body);

  const body = (overrides: Record<string, unknown> = {}) => ({
    amount: 10000,
    reasonCode: 'CS_REFUND',
    reason: 'CS 문의 — 중복 결제 환불',
    idempotencyKey: `cs-ticket-${seq++}`,
    ...overrides,
  });

  const cancelCount = async (paymentId: string) =>
    (await ctx.dataSource.query<unknown[]>('SELECT 1 FROM tb_payment_cancel WHERE payment_id = $1', [paymentId]))
      .length;

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start() });
    service = await onboardPayableService(ctx);
  });
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

  it('환불하고 requestedBy=ADMIN, 사유는 토스 취소 사유로, 감사 로그 PAYMENT_CANCELED_BY_ADMIN(사유 포함)', async () => {
    const paymentId = await paid();
    const res = await adminCancel(paymentId, body());

    expect(res.status).toBe(200);
    expect(dataOf<CancelResult>(res)).toMatchObject({
      cancel: { status: 'DONE', amount: 10000, requestedBy: 'ADMIN', reasonDetail: 'CS 문의 — 중복 결제 환불' },
      payment: { paymentId, serviceId: service.serviceId, status: 'PARTIAL_CANCELED', refundableAmount: 20000 },
    });
    expect(toss.requests[0].body).toMatchObject({ cancelReason: 'CS 문의 — 중복 결제 환불', cancelAmount: 10000 });

    expect(await auditActionsOf(ctx, paymentId)).toEqual(['PAYMENT_CANCELED_BY_ADMIN']);
    const [log] = await ctx.dataSource.query<{ reason: string; service_id: string; after: { amount: number } }[]>(
      'SELECT reason, service_id, after FROM tb_admin_audit_log WHERE target_id = $1',
      [paymentId],
    );
    expect(log).toMatchObject({
      reason: 'CS 문의 — 중복 결제 환불',
      service_id: service.serviceId,
      after: { amount: 10000 },
    });
  });

  it('사유가 없으면 400 ADMIN_REASON_REQUIRED — 토스를 부르지 않고 취소도 남기지 않는다', async () => {
    const paymentId = await paid();
    const res = await adminCancel(paymentId, body({ reason: undefined }));

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('ADMIN_REASON_REQUIRED');
    expect(toss.requests).toHaveLength(0);
    expect(await cancelCount(paymentId)).toBe(0);
  });

  it('같은 idempotencyKey 재요청은 같은 결과, 감사 로그는 한 번', async () => {
    const paymentId = await paid();
    const request = body();
    const first = dataOf<CancelResult>(await adminCancel(paymentId, request));
    const again = await adminCancel(paymentId, request);

    expect(dataOf<CancelResult>(again).cancel.paymentCancelId).toBe(first.cancel.paymentCancelId);
    expect(toss.requests).toHaveLength(1);
    expect(await auditActionsOf(ctx, paymentId)).toEqual(['PAYMENT_CANCELED_BY_ADMIN']);
  });

  it('admin 멱등키는 서비스의 환불 멱등키와 섞이지 않는다 (같은 문자열이어도 별개 환불)', async () => {
    const paymentId = await paid();
    await ctx
      .http()
      .post(`/api/v1/payments/${paymentId}/cancel`)
      .set('Authorization', `Bearer ${service.apiKey}`)
      .send({ amount: 5000, reasonCode: 'USER_REQUEST', idempotencyKey: 'shared-key' });

    const res = await adminCancel(paymentId, body({ amount: 5000, idempotencyKey: 'shared-key' }));

    expect(res.status).toBe(200);
    expect(await cancelCount(paymentId)).toBe(2);
  });

  it('환불 가능 금액 초과는 서비스 환불과 같은 규칙 → 400 CANCEL_AMOUNT_EXCEEDED, 감사 로그 없음', async () => {
    const paymentId = await paid();
    const res = await adminCancel(paymentId, body({ amount: 30001 }));

    expect(errorOf(res)).toMatchObject({ code: 'CANCEL_AMOUNT_EXCEEDED', detail: { refundableAmount: 30000 } });
    expect(await auditActionsOf(ctx, paymentId)).toEqual([]);
  });

  it('없는 결제는 404 PAYMENT_NOT_FOUND', async () => {
    const res = await adminCancel('00000000-0000-4000-8000-000000000000', body());

    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('PAYMENT_NOT_FOUND');
  });

  it('서비스 API 키로는 호출할 수 없다 (401)', async () => {
    const paymentId = await paid();
    const res = await ctx
      .http()
      .post(`/api/v1/admin/payments/${paymentId}/cancel`)
      .set('Authorization', `Bearer ${service.apiKey}`)
      .send(body());

    expect(res.status).toBe(401);
  });
});
