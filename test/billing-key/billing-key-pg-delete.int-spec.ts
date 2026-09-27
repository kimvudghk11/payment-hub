import { BillingKeyPgDeleter } from '../../src/billing-key/billing-key-pg-deleter';
import { BILLING_KEY_PG_DELETE_MAX_ATTEMPTS } from '../../src/billing-key/constants/billing-key.constants';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss } from '../support/fake-toss';
import { IntegrationApp, createIntegrationApp, dataOf } from '../support/integration-app';

interface BillingKeyData {
  billingKeyId: string;
  status: string;
}

interface PgDeleteRow {
  status: string;
  pg_deleted_at: Date | null;
  pg_delete_attempt_count: number;
}

let seq = 0;
/** 재시도 간격(지수 백오프)이 모두 지난 시각 */
const farFuture = () => new Date(Date.now() + 365 * 24 * 60 * 60_000);

describe('빌링키 해제 → 토스 쪽 삭제', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let service: PayableService;
  let deleter: BillingKeyPgDeleter;

  const auth = () => ({ Authorization: `Bearer ${service.apiKey}` });
  const issue = async (): Promise<{ billingKeyId: string; billingKey: string }> => {
    const billingKey = `bk_SECRET_${seq++}`;
    toss.respond((request) => ({
      status: 200,
      body: { customerKey: request.body.customerKey, billingKey, cardCompany: '현대', cardNumber: '433012******1234' },
    }));
    const res = await ctx
      .http()
      .post('/api/v1/billing-keys')
      .set(auth())
      .send({ externalUserId: 'user-del', customerKey: `c_del_${seq++}`, authKey: `bln_${seq++}` });
    toss.reset();
    return { billingKeyId: dataOf<BillingKeyData>(res).billingKeyId, billingKey };
  };
  const revoke = (billingKeyId: string) => ctx.http().delete(`/api/v1/billing-keys/${billingKeyId}`).set(auth());
  const row = async (billingKeyId: string): Promise<PgDeleteRow> => {
    const [found] = await ctx.dataSource.query<PgDeleteRow[]>(
      'SELECT status, pg_deleted_at, pg_delete_attempt_count FROM tb_billing_key WHERE id = $1',
      [billingKeyId],
    );
    return found;
  };
  const deleteRequests = () => toss.requests.filter((request) => request.method === 'DELETE');
  const runBatch = () => deleter.deleteDue(farFuture(), 1000);

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), TOSS_API_TIMEOUT_MS: '300' });
    service = await onboardPayableService(ctx);
    deleter = ctx.app.get(BillingKeyPgDeleter);
  });
  afterEach(() => toss.reset());
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  it('해제하면 hub 폐기 후 토스에 복호화한 빌링키로 삭제를 요청하고, 삭제 시각을 기록한다', async () => {
    const { billingKeyId, billingKey } = await issue();
    toss.respond(() => ({ status: 200, body: {} }));

    const res = await revoke(billingKeyId);

    expect(res.status).toBe(200);
    expect(dataOf<BillingKeyData>(res).status).toBe('REVOKED');
    expect(deleteRequests().map((request) => request.path)).toEqual([`/v1/billing/${billingKey}`]);
    expect(await row(billingKeyId)).toMatchObject({ status: 'REVOKED', pg_delete_attempt_count: 0 });
    expect((await row(billingKeyId)).pg_deleted_at).not.toBeNull();
  });

  it('토스가 이미 없다고(404) 하면 삭제된 것으로 기록한다', async () => {
    const { billingKeyId } = await issue();
    toss.respond(() => ({ status: 404, body: { code: 'NOT_FOUND_BILLING_KEY', message: '없음' } }));

    await revoke(billingKeyId);

    expect((await row(billingKeyId)).pg_deleted_at).not.toBeNull();
  });

  it('토스 삭제가 타임아웃이어도 해제는 200 REVOKED, 시도 1회로 기록되고 배치가 나중에 삭제한다', async () => {
    const { billingKeyId } = await issue();
    toss.respond(() => ({ status: 200, body: {}, delayMs: 1000 }));

    const res = await revoke(billingKeyId);

    expect(res.status).toBe(200);
    expect(dataOf<BillingKeyData>(res).status).toBe('REVOKED');
    expect(await row(billingKeyId)).toMatchObject({ pg_deleted_at: null, pg_delete_attempt_count: 1 });

    toss.respond(() => ({ status: 200, body: {} }));
    await runBatch();

    expect((await row(billingKeyId)).pg_deleted_at).not.toBeNull();
  });

  it('이미 토스에서 삭제된 키를 다시 해제하면 토스를 다시 호출하지 않는다 (멱등)', async () => {
    const { billingKeyId } = await issue();
    toss.respond(() => ({ status: 200, body: {} }));
    await revoke(billingKeyId);
    toss.reset();

    const again = await revoke(billingKeyId);

    expect(again.status).toBe(200);
    expect(deleteRequests()).toHaveLength(0);
  });

  it('배치는 시도 횟수에 따른 대기(지수 백오프)가 지나지 않은 키를 건너뛴다', async () => {
    const { billingKeyId, billingKey } = await issue();
    toss.respond(() => ({ status: 500, body: {} }));
    await revoke(billingKeyId);
    toss.reset();

    await deleter.deleteDue(new Date(), 1000);

    expect(deleteRequests().filter((request) => request.path === `/v1/billing/${billingKey}`)).toHaveLength(0);
    expect(await row(billingKeyId)).toMatchObject({ pg_deleted_at: null, pg_delete_attempt_count: 1 });
  });

  it('거절이 계속되면 시도 한도에서 멈추고, 한도에 이른 키는 배치가 더 이상 잡지 않는다', async () => {
    const { billingKeyId } = await issue();
    toss.respond(() => ({ status: 401, body: { code: 'UNAUTHORIZED_KEY', message: '인증 실패' } }));
    await revoke(billingKeyId);
    for (let i = 1; i < BILLING_KEY_PG_DELETE_MAX_ATTEMPTS + 2; i += 1) await runBatch();

    expect(await row(billingKeyId)).toMatchObject({
      pg_deleted_at: null,
      pg_delete_attempt_count: BILLING_KEY_PG_DELETE_MAX_ATTEMPTS,
    });
  });

  it('복호화할 수 없는 키가 섞여 있어도 나머지는 삭제되고, 깨진 키는 실패 시도로 기록된다', async () => {
    const broken = await issue();
    const healthy = await issue();
    toss.respond(() => ({ status: 500, body: {} }));
    await revoke(broken.billingKeyId);
    await revoke(healthy.billingKeyId);
    await ctx.dataSource.query(
      `UPDATE tb_billing_key SET billing_key_enc = decode(repeat('00', 40), 'hex') WHERE id = $1`,
      [broken.billingKeyId],
    );
    toss.respond(() => ({ status: 200, body: {} }));

    const result = await runBatch();

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect((await row(healthy.billingKeyId)).pg_deleted_at).not.toBeNull();
    expect(await row(broken.billingKeyId)).toMatchObject({ pg_deleted_at: null, pg_delete_attempt_count: 2 });
  });
});
