import { AdminAuditService } from '../../src/admin/audit/admin-audit.service';
import { auditActionsOf, onboardPayableService, PayableService } from '../support/admin-fixtures';
import { FakeToss, approvedCardPayment } from '../support/fake-toss';
import { IntegrationApp, adminHeaders, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface Delivery {
  webhookDeliveryId: string;
  eventType: string;
  serviceId: string;
  status: string;
  attemptCount: number;
  targetUrl: string;
}
interface Page<T> {
  data: T[];
  totalCount: number;
  nextCursor: string | null;
}

let seq = 0;

describe('관리자 API — 운영 큐', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let service: PayableService;

  const auth = (target: PayableService) => ({ Authorization: `Bearer ${target.apiKey}` });
  const createOrder = async (target: PayableService): Promise<string> => {
    const res = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth(target))
      .send({
        externalOrderId: `ops-order-${Date.now()}-${seq++}`,
        externalUserId: 'user-1',
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 30000, quantity: 1 }],
        totalAmount: 30000,
      });
    return dataOf<{ orderId: string }>(res).orderId;
  };
  const confirm = (target: PayableService, orderId: string, paymentKey = `tgen_ops_${seq++}`) =>
    ctx.http().post('/api/v1/payments/confirm').set(auth(target)).send({ orderId, paymentKey, amount: 30000 });

  /** 결제 승인 → PAYMENT_CONFIRMED 전달 대상을 DEAD로 만든다 */
  const deadDelivery = async (target: PayableService = service): Promise<{ deliveryId: string; paymentId: string }> => {
    const { paymentId } = dataOf<{ paymentId: string }>(await confirm(target, await createOrder(target)));
    // UPDATE … RETURNING은 [행 목록, 변경 건수]로 온다
    const [rows] = await ctx.dataSource.query<[{ id: string }[], number]>(
      `UPDATE tb_webhook_delivery d SET status = 'DEAD', attempt_count = 10, last_http_status = 404, last_error = 'HTTP 404'
         FROM tb_outbox_event e WHERE e.id = d.event_id AND e.aggregate_id = $1 RETURNING d.id`,
      [paymentId],
    );
    return { deliveryId: rows[0].id, paymentId };
  };

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), TOSS_API_TIMEOUT_MS: '300' });
    service = await onboardPayableService(ctx);
  });
  afterEach(() => toss.reset());
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  describe('웹훅 전달 — GET /admin/ops/webhook-deliveries, POST …/:id/redeliver', () => {
    it('DEAD 건을 서비스별로 최신순 조회 (이벤트 유형·마지막 오류 포함)', async () => {
      const other = await onboardPayableService(ctx);
      const { deliveryId } = await deadDelivery();
      await deadDelivery(other);

      const res = await ctx
        .http()
        .get(`/api/v1/admin/ops/webhook-deliveries?status=DEAD&serviceId=${service.serviceId}`)
        .set(adminHeaders);

      expect(res.status).toBe(200);
      const page = dataOf<Page<Delivery & { lastError: string }>>(res);
      expect(page.data.every((delivery) => delivery.serviceId === service.serviceId)).toBe(true);
      expect(page.data[0]).toMatchObject({
        webhookDeliveryId: deliveryId,
        eventType: 'PAYMENT_CONFIRMED',
        status: 'DEAD',
        lastError: 'HTTP 404',
      });
    });

    it('재전송: PENDING으로 돌리고, 서비스의 현재 webhookUrl로 바꾸고, 감사 로그를 남긴다', async () => {
      const { deliveryId } = await deadDelivery();
      await ctx
        .http()
        .patch(`/api/v1/admin/services/${service.serviceId}`)
        .set(adminHeaders)
        .send({ webhookUrl: 'https://fixed.example.com/hook' });

      const res = await ctx
        .http()
        .post(`/api/v1/admin/ops/webhook-deliveries/${deliveryId}/redeliver`)
        .set(adminHeaders)
        .send({ reason: 'URL 수정 후 재전송' });

      expect(res.status).toBe(200);
      expect(dataOf<Delivery>(res)).toMatchObject({
        status: 'PENDING',
        attemptCount: 10,
        targetUrl: 'https://fixed.example.com/hook',
      });
      expect(await auditActionsOf(ctx, deliveryId)).toEqual(['WEBHOOK_REDELIVERED']);
      const [log] = await ctx.dataSource.query<{ before: { status: string }; after: { status: string } }[]>(
        `SELECT before, after FROM tb_admin_audit_log WHERE target_id = $1`,
        [deliveryId],
      );
      expect(log).toMatchObject({ before: { status: 'DEAD' }, after: { status: 'PENDING' } });
    });

    it('이미 대기 중인 건을 다시 재전송하면 200 + 현재 상태, 감사 로그 없음 (멱등)', async () => {
      const { deliveryId } = await deadDelivery();
      const url = `/api/v1/admin/ops/webhook-deliveries/${deliveryId}/redeliver`;
      await ctx.http().post(url).set(adminHeaders).send({});
      const again = await ctx.http().post(url).set(adminHeaders).send({});

      expect(again.status).toBe(200);
      expect(await auditActionsOf(ctx, deliveryId)).toEqual(['WEBHOOK_REDELIVERED']);
    });

    it('서비스에 webhookUrl이 없으면 보낼 곳이 없으므로 400 INVALID_REQUEST', async () => {
      const noHook = await onboardPayableService(ctx);
      const { deliveryId } = await deadDelivery(noHook);
      await ctx.http().patch(`/api/v1/admin/services/${noHook.serviceId}`).set(adminHeaders).send({ webhookUrl: null });

      const res = await ctx
        .http()
        .post(`/api/v1/admin/ops/webhook-deliveries/${deliveryId}/redeliver`)
        .set(adminHeaders)
        .send({});

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('INVALID_REQUEST');
    });

    it('없는 전달 건은 404 RESOURCE_NOT_FOUND', async () => {
      const res = await ctx
        .http()
        .post('/api/v1/admin/ops/webhook-deliveries/00000000-0000-4000-8000-000000000000/redeliver')
        .set(adminHeaders)
        .send({});

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('결과 불명 결제 — GET /admin/ops/unknown-payments, POST /admin/ops/payments/:id/reconcile', () => {
    /** 승인 응답이 늦어 UNKNOWN으로 남은 결제 */
    const unknownPayment = async () => {
      toss.respond((request) => ({ status: 200, body: approvedCardPayment(request), delayMs: 1000 }));
      const orderId = await createOrder(service);
      const paymentKey = `tgen_ops_unknown_${seq++}`;
      const res = await confirm(service, orderId, paymentKey);
      toss.reset();
      return { orderId, paymentKey, paymentId: errorOf(res).detail?.paymentId as string };
    };

    it('IN_PROGRESS·UNKNOWN 결제를 오래된 순으로', async () => {
      const first = await unknownPayment();
      const second = await unknownPayment();

      const res = await ctx
        .http()
        .get(`/api/v1/admin/ops/unknown-payments?serviceId=${service.serviceId}`)
        .set(adminHeaders);

      expect(res.status).toBe(200);
      const ids = dataOf<Page<{ paymentId: string; status: string }>>(res).data.map((payment) => payment.paymentId);
      expect(ids.indexOf(first.paymentId)).toBeLessThan(ids.indexOf(second.paymentId));
    });

    it('수동 대사: 토스 조회로 바로 확정하고 감사 로그(before/after 상태)를 남긴다', async () => {
      const { orderId, paymentKey, paymentId } = await unknownPayment();
      toss.respond((request) => ({
        status: 200,
        body: approvedCardPayment({ ...request, body: { orderId, paymentKey, amount: 30000 } }),
      }));

      const res = await ctx
        .http()
        .post(`/api/v1/admin/ops/payments/${paymentId}/reconcile`)
        .set(adminHeaders)
        .send({ reason: 'CS 문의로 확인' });

      expect(res.status).toBe(200);
      expect(dataOf<{ resolved: boolean; payment: { status: string } }>(res)).toMatchObject({
        resolved: true,
        payment: { status: 'DONE' },
      });
      expect(await auditActionsOf(ctx, paymentId)).toEqual(['PAYMENT_RECONCILED']);
      const [log] = await ctx.dataSource.query<{ before: object; after: object; reason: string }[]>(
        `SELECT before, after, reason FROM tb_admin_audit_log WHERE target_id = $1`,
        [paymentId],
      );
      expect(log).toMatchObject({ before: { status: 'UNKNOWN' }, after: { status: 'DONE' }, reason: 'CS 문의로 확인' });
    });

    it('토스도 아직 모르면 resolved=false + 현재 상태, 감사 로그 없음', async () => {
      const { paymentId, paymentKey } = await unknownPayment();
      toss.respond(() => ({ status: 200, body: { paymentKey, status: 'IN_PROGRESS' } }));

      const res = await ctx.http().post(`/api/v1/admin/ops/payments/${paymentId}/reconcile`).set(adminHeaders).send({});

      expect(dataOf<{ resolved: boolean; payment: { status: string } }>(res)).toMatchObject({
        resolved: false,
        payment: { status: 'UNKNOWN' },
      });
      expect(await auditActionsOf(ctx, paymentId)).toEqual([]);
    });

    it('감사 로그 기록이 실패하면 대사 확정도 롤백된다 (같은 트랜잭션)', async () => {
      const { orderId, paymentKey, paymentId } = await unknownPayment();
      toss.respond((request) => ({
        status: 200,
        body: approvedCardPayment({ ...request, body: { orderId, paymentKey, amount: 30000 } }),
      }));
      const audit = ctx.app.get(AdminAuditService);
      const spy = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit down'));
      try {
        const res = await ctx
          .http()
          .post(`/api/v1/admin/ops/payments/${paymentId}/reconcile`)
          .set(adminHeaders)
          .send({});
        expect(res.status).toBe(500);
      } finally {
        spy.mockRestore();
      }

      const [row] = await ctx.dataSource.query<{ status: string }[]>('SELECT status FROM tb_payment WHERE id = $1', [
        paymentId,
      ]);
      expect(row.status).toBe('UNKNOWN');
      const ledger = await ctx.dataSource.query<unknown[]>(
        'SELECT 1 FROM tb_ledger_transaction WHERE reference_id = $1',
        [paymentId],
      );
      expect(ledger).toHaveLength(0);
    });

    it('이미 확정된 결제는 토스를 부르지 않고 resolved=false (멱등)', async () => {
      const { paymentId } = dataOf<{ paymentId: string }>(await confirm(service, await createOrder(service)));
      toss.reset();

      const res = await ctx.http().post(`/api/v1/admin/ops/payments/${paymentId}/reconcile`).set(adminHeaders).send({});

      expect(dataOf<{ resolved: boolean; payment: { status: string } }>(res)).toMatchObject({
        resolved: false,
        payment: { status: 'DONE' },
      });
      expect(toss.requests).toHaveLength(0);
    });
  });
});
