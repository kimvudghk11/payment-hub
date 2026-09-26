import { AdminAuditService } from '../../src/admin/audit/admin-audit.service';
import {
  ADMIN_ACTOR,
  IntegrationApp,
  adminHeaders,
  createIntegrationApp,
  dataOf,
  errorOf,
  uniqueServiceCode,
} from '../support/integration-app';

interface ServiceData {
  serviceId: string;
  code: string;
  name: string;
  status: string;
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  webhookSecret?: string;
  deletedAt: string | null;
}
interface PageData<T> {
  data: T[];
  totalCount: number;
  nextCursor: string | null;
}
interface AuditRow {
  action: string;
  actor_id: string;
  actor_name: string | null;
  target_id: string;
  service_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}

describe('관리자 API — 서비스', () => {
  let ctx: IntegrationApp;

  beforeAll(async () => {
    ctx = await createIntegrationApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const createService = async (overrides: Record<string, unknown> = {}) => {
    const res = await ctx
      .http()
      .post('/api/v1/admin/services')
      .set(adminHeaders)
      .send({
        code: uniqueServiceCode(),
        name: '서비스 A',
        webhookUrl: 'https://svc-a.example.com/hook',
        ...overrides,
      });
    expect(res.status).toBe(201);
    return dataOf<ServiceData>(res);
  };

  const auditLogsOf = (targetId: string) =>
    ctx.dataSource.query<AuditRow[]>(
      `SELECT action, actor_id, actor_name, target_id, service_id, before, after, reason
         FROM tb_admin_audit_log WHERE target_id = $1 ORDER BY created_at`,
      [targetId],
    );

  describe('POST /admin/services — 등록', () => {
    it('ACTIVE 서비스를 만들고 웹훅 서명 키 평문을 이 응답에서만 돌려준다', async () => {
      const service = await createService();

      expect(service).toMatchObject({ status: 'ACTIVE', hasWebhookSecret: true, deletedAt: null });
      expect(service.webhookSecret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);

      const [row] = await ctx.dataSource.query<{ webhook_secret_enc: Buffer; webhook_secret_key_id: string }[]>(
        'SELECT webhook_secret_enc, webhook_secret_key_id FROM tb_service WHERE id = $1',
        [service.serviceId],
      );
      expect(row.webhook_secret_key_id).toBe('v1');
      expect(row.webhook_secret_enc.toString('latin1')).not.toContain(service.webhookSecret);
    });

    it('같은 트랜잭션에서 감사 로그 SERVICE_CREATED를 남기고, 비밀값은 넣지 않는다', async () => {
      const service = await createService();

      const logs = await auditLogsOf(service.serviceId);

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: 'SERVICE_CREATED',
        actor_id: ADMIN_ACTOR,
        actor_name: '홍길동',
        service_id: service.serviceId,
        before: null,
        after: expect.objectContaining({ code: service.code, status: 'ACTIVE' }) as unknown,
      });
      expect(JSON.stringify(logs[0])).not.toContain(service.webhookSecret);
    });

    it('이미 쓰는 코드면 409 SERVICE_CODE_DUPLICATED', async () => {
      const service = await createService();

      const res = await ctx
        .http()
        .post('/api/v1/admin/services')
        .set(adminHeaders)
        .send({ code: service.code, name: '중복' });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('SERVICE_CODE_DUPLICATED');
    });

    it('코드 형식이 틀리면 400 INVALID_REQUEST, 한국어 필드 메시지', async () => {
      const res = await ctx
        .http()
        .post('/api/v1/admin/services')
        .set(adminHeaders)
        .send({ code: 'svc-a', name: 'A', webhookUrl: 'ftp://files.example.com' });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('INVALID_REQUEST');
      expect(errorOf(res).detail?.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'code' }),
          { field: 'webhookUrl', message: 'webhookUrl은 http(s) URL이어야 합니다.' },
        ]),
      );
    });

    it('TEST 배포는 로컬 개발용 http://localhost 웹훅 URL을 허용한다', async () => {
      const res = await ctx
        .http()
        .post('/api/v1/admin/services')
        .set(adminHeaders)
        .send({ code: uniqueServiceCode(), name: '로컬', webhookUrl: 'http://localhost:4000/webhooks/payment-hub' });

      expect(res.status).toBe(201);
      expect(dataOf<ServiceData>(res).webhookUrl).toBe('http://localhost:4000/webhooks/payment-hub');
    });

    it('admin 키가 없으면 401', async () => {
      const res = await ctx.http().post('/api/v1/admin/services').send({ code: uniqueServiceCode(), name: 'A' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /admin/services — 조회', () => {
    it('상세 응답에는 서명 키 평문이 없다', async () => {
      const service = await createService();

      const res = await ctx.http().get(`/api/v1/admin/services/${service.serviceId}`).set(adminHeaders);

      expect(res.status).toBe(200);
      expect(dataOf<ServiceData>(res)).toMatchObject({ serviceId: service.serviceId, hasWebhookSecret: true });
      expect(dataOf<ServiceData>(res).webhookSecret).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('Enc');
    });

    it('없는 서비스는 404 RESOURCE_NOT_FOUND', async () => {
      const res = await ctx.http().get('/api/v1/admin/services/00000000-0000-4000-8000-000000000000').set(adminHeaders);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('목록은 최신순 cursor 페이징이고 다음 페이지와 겹치지 않는다', async () => {
      await createService();
      await createService();

      const first = dataOf<PageData<ServiceData>>(
        await ctx.http().get('/api/v1/admin/services?limit=1').set(adminHeaders),
      );
      const second = dataOf<PageData<ServiceData>>(
        await ctx.http().get(`/api/v1/admin/services?limit=1&cursor=${first.nextCursor}`).set(adminHeaders),
      );

      expect(first.data).toHaveLength(1);
      expect(first.totalCount).toBeGreaterThanOrEqual(2);
      expect(first.nextCursor).not.toBeNull();
      expect(second.data).toHaveLength(1);
      expect(second.data[0].serviceId).not.toBe(first.data[0].serviceId);
    });
  });

  describe('PATCH /admin/services/:id — 수정', () => {
    it('이름을 바꾸면 SERVICE_UPDATED, 웹훅 URL만 바꾸면 WEBHOOK_CONFIG_UPDATED', async () => {
      const service = await createService();

      await ctx.http().patch(`/api/v1/admin/services/${service.serviceId}`).set(adminHeaders).send({ name: '새 이름' });
      const res = await ctx
        .http()
        .patch(`/api/v1/admin/services/${service.serviceId}`)
        .set(adminHeaders)
        .send({ webhookUrl: null });

      expect(dataOf<ServiceData>(res)).toMatchObject({ name: '새 이름', webhookUrl: null });
      const actions = (await auditLogsOf(service.serviceId)).map((log) => log.action);
      expect(actions).toEqual(['SERVICE_CREATED', 'SERVICE_UPDATED', 'WEBHOOK_CONFIG_UPDATED']);
    });

    it('바뀐 값이 없으면 감사 로그를 남기지 않는다', async () => {
      const service = await createService();

      await ctx
        .http()
        .patch(`/api/v1/admin/services/${service.serviceId}`)
        .set(adminHeaders)
        .send({ name: '서비스 A' });

      expect(await auditLogsOf(service.serviceId)).toHaveLength(1);
    });
  });

  describe('정지 / 재개', () => {
    it('사유 없이 정지하면 400 ADMIN_REASON_REQUIRED, 상태는 그대로', async () => {
      const service = await createService();

      const res = await ctx.http().post(`/api/v1/admin/services/${service.serviceId}/suspend`).set(adminHeaders);

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('ADMIN_REASON_REQUIRED');
      const [row] = await ctx.dataSource.query<{ status: string }[]>('SELECT status FROM tb_service WHERE id = $1', [
        service.serviceId,
      ]);
      expect(row.status).toBe('ACTIVE');
    });

    it('정지·재개하고, 같은 요청을 다시 보내면 200이지만 감사 로그는 한 번만 남는다', async () => {
      const service = await createService();
      const suspend = () =>
        ctx
          .http()
          .post(`/api/v1/admin/services/${service.serviceId}/suspend`)
          .set(adminHeaders)
          .send({ reason: '이상 거래 조사' });

      expect(dataOf<ServiceData>(await suspend()).status).toBe('SUSPENDED');
      expect((await suspend()).status).toBe(200);
      const resumed = await ctx.http().post(`/api/v1/admin/services/${service.serviceId}/resume`).set(adminHeaders);

      expect(dataOf<ServiceData>(resumed).status).toBe('ACTIVE');
      const logs = await auditLogsOf(service.serviceId);
      expect(logs.map((log) => log.action)).toEqual(['SERVICE_CREATED', 'SERVICE_SUSPENDED', 'SERVICE_RESUMED']);
      expect(logs[1]).toMatchObject({ reason: '이상 거래 조사' });
    });

    it('감사 로그 기록이 실패하면 상태 변경도 롤백된다 (같은 트랜잭션)', async () => {
      const service = await createService();
      const audit = ctx.app.get(AdminAuditService);
      const spy = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit insert failed'));

      const res = await ctx
        .http()
        .post(`/api/v1/admin/services/${service.serviceId}/suspend`)
        .set(adminHeaders)
        .send({ reason: '롤백 확인' });
      spy.mockRestore();

      expect(res.status).toBe(500);
      const [row] = await ctx.dataSource.query<{ status: string }[]>('SELECT status FROM tb_service WHERE id = $1', [
        service.serviceId,
      ]);
      expect(row.status).toBe('ACTIVE');
    });
  });

  describe('DELETE /admin/services/:id — 삭제', () => {
    it('사유가 있어야 삭제되고, 삭제 후에는 조회·목록에서 사라진다', async () => {
      const service = await createService();
      const url = `/api/v1/admin/services/${service.serviceId}`;

      const withoutReason = await ctx.http().delete(url).set(adminHeaders);
      const deleted = await ctx.http().delete(url).set(adminHeaders).send({ reason: '서비스 종료' });
      const afterGet = await ctx.http().get(url).set(adminHeaders);
      const list = dataOf<PageData<ServiceData>>(
        await ctx.http().get('/api/v1/admin/services?limit=100').set(adminHeaders),
      );
      const withDeleted = dataOf<PageData<ServiceData>>(
        await ctx.http().get('/api/v1/admin/services?limit=100&includeDeleted=true').set(adminHeaders),
      );

      expect(errorOf(withoutReason).code).toBe('ADMIN_REASON_REQUIRED');
      expect(deleted.status).toBe(200);
      expect(afterGet.status).toBe(404);
      expect(list.data.map((s) => s.serviceId)).not.toContain(service.serviceId);
      expect(withDeleted.data.map((s) => s.serviceId)).toContain(service.serviceId);
    });
  });

  describe('POST /admin/services/:id/webhook-secret/rotate', () => {
    it('새 서명 키를 1회 돌려주고 감사 로그에는 남기지 않는다', async () => {
      const service = await createService();

      const res = await ctx
        .http()
        .post(`/api/v1/admin/services/${service.serviceId}/webhook-secret/rotate`)
        .set(adminHeaders);

      const { webhookSecret } = dataOf<{ webhookSecret: string }>(res);
      expect(webhookSecret).toMatch(/^whsec_/);
      expect(webhookSecret).not.toBe(service.webhookSecret);
      const logs = await auditLogsOf(service.serviceId);
      expect(logs.map((log) => log.action)).toContain('WEBHOOK_SECRET_ROTATED');
      expect(JSON.stringify(logs)).not.toContain(webhookSecret);
    });
  });
});
