import { createService } from '../support/admin-fixtures';
import { IntegrationApp, adminHeaders, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface AuditLog {
  adminAuditLogId: string;
  actorId: string;
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: string;
  serviceId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  createdAt: string;
}
interface Page<T> {
  data: T[];
  totalCount: number;
  nextCursor: string | null;
}

describe('관리자 API — 감사 로그 조회 GET /admin/audit-logs', () => {
  let ctx: IntegrationApp;
  let serviceId: string;

  const get = (query: string) => ctx.http().get(`/api/v1/admin/audit-logs${query}`).set(adminHeaders);

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    ({ serviceId } = await createService(ctx));
    const other = { ...adminHeaders, 'X-Admin-Actor-Id': 'admin-99' };
    await ctx.http().post(`/api/v1/admin/services/${serviceId}/suspend`).set(other).send({ reason: '이상 거래 조사' });
    await ctx.http().post(`/api/v1/admin/services/${serviceId}/resume`).set(adminHeaders).send({});
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('서비스별로 최신순, 누가·무엇을·왜·전후 값', async () => {
    const res = await get(`?serviceId=${serviceId}`);

    expect(res.status).toBe(200);
    const page = dataOf<Page<AuditLog>>(res);
    expect(page.data.map((log) => log.action)).toEqual(['SERVICE_RESUMED', 'SERVICE_SUSPENDED', 'SERVICE_CREATED']);
    expect(page.data[1]).toMatchObject({
      actorId: 'admin-99',
      targetType: 'SERVICE',
      targetId: serviceId,
      reason: '이상 거래 조사',
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED' },
    });
  });

  it('작업자·작업 종류로 거른다', async () => {
    const byActor = dataOf<Page<AuditLog>>(await get(`?serviceId=${serviceId}&actorId=admin-99`));
    const byAction = dataOf<Page<AuditLog>>(await get(`?serviceId=${serviceId}&action=SERVICE_CREATED`));

    expect(byActor.data.map((log) => log.action)).toEqual(['SERVICE_SUSPENDED']);
    expect(byAction.totalCount).toBe(1);
  });

  it('대상(targetType + targetId)으로 거르고 cursor로 이어 본다', async () => {
    const first = dataOf<Page<AuditLog>>(await get(`?targetType=SERVICE&targetId=${serviceId}&limit=2`));
    const second = dataOf<Page<AuditLog>>(
      await get(
        `?targetType=SERVICE&targetId=${serviceId}&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      ),
    );

    expect(first.data).toHaveLength(2);
    expect(second.data.map((log) => log.action)).toEqual(['SERVICE_CREATED']);
    expect(second.nextCursor).toBeNull();
  });

  it('알 수 없는 작업 종류는 400 INVALID_REQUEST', async () => {
    const res = await get('?action=DROP_TABLE');
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('INVALID_REQUEST');
  });

  it('조회는 감사 로그를 남기지 않는다', async () => {
    const before = dataOf<Page<AuditLog>>(await get('?limit=1')).totalCount;
    await get('');
    expect(dataOf<Page<AuditLog>>(await get('?limit=1')).totalCount).toBe(before);
  });
});
