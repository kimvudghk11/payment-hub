import { EncryptionService } from '../../src/common/crypto/encryption.service';
import { auditActionsOf, createService, issueApiKey } from '../support/admin-fixtures';
import { IntegrationApp, adminHeaders, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface CredentialData {
  pgCredentialId: string;
  environment: string;
  merchantId: string | null;
  clientKey: string;
  secretKeyHint: string;
  isActive: boolean;
}

// 통합 테스트 배포는 PG_ENVIRONMENT=TEST
const testKeys = (suffix: string) => ({
  environment: 'TEST',
  merchantId: 'tosspayments',
  clientKey: `test_ck_${suffix}`,
  secretKey: `test_sk_secret_${suffix}`,
});

describe('관리자 API — PG 자격증명 / 서비스 API — PG 설정', () => {
  let ctx: IntegrationApp;

  beforeAll(async () => {
    ctx = await createIntegrationApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const register = (serviceId: string, body: Record<string, unknown>) =>
    ctx.http().post(`/api/v1/admin/services/${serviceId}/pg-credentials`).set(adminHeaders).send(body);

  const clientConfig = (apiKey: string) =>
    ctx.http().get('/api/v1/pg/client-config').set('Authorization', `Bearer ${apiKey}`);

  describe('등록', () => {
    it('시크릿 키를 암호화해 저장하고, 응답에는 hint만 준다', async () => {
      const service = await createService(ctx);
      const keys = testKeys('a1');

      const res = await register(service.serviceId, keys);

      expect(res.status).toBe(201);
      const credential = dataOf<CredentialData>(res);
      expect(credential).toMatchObject({ environment: 'TEST', clientKey: keys.clientKey, isActive: true });
      expect(credential.secretKeyHint).toBe(keys.secretKey.slice(-4));
      expect(JSON.stringify(res.body)).not.toContain(keys.secretKey);

      const [row] = await ctx.dataSource.query<{ secret_key_enc: Buffer; secret_key_id: string }[]>(
        'SELECT secret_key_enc, secret_key_id FROM tb_pg_credential WHERE id = $1',
        [credential.pgCredentialId],
      );
      expect(row.secret_key_enc.toString('latin1')).not.toContain(keys.secretKey);
      expect(ctx.app.get(EncryptionService).decrypt(row.secret_key_enc, row.secret_key_id)).toBe(keys.secretKey);
    });

    it('같은 환경에 다시 등록하면 기존 키는 같은 트랜잭션에서 비활성된다', async () => {
      const service = await createService(ctx);
      const first = dataOf<CredentialData>(await register(service.serviceId, testKeys('old')));

      const second = dataOf<CredentialData>(await register(service.serviceId, testKeys('new')));
      const list = dataOf<CredentialData[]>(
        await ctx.http().get(`/api/v1/admin/services/${service.serviceId}/pg-credentials`).set(adminHeaders),
      );

      expect(list.map((c) => [c.pgCredentialId, c.isActive])).toEqual([
        [second.pgCredentialId, true],
        [first.pgCredentialId, false],
      ]);
      const [audit] = await ctx.dataSource.query<{ before: { clientKey: string } }[]>(
        'SELECT before FROM tb_admin_audit_log WHERE target_id = $1',
        [second.pgCredentialId],
      );
      expect(audit.before.clientKey).toBe('test_ck_old');
      expect(JSON.stringify(list)).not.toMatch(/secret_sk|secretKeyEnc/);
    });

    it('환경과 다른 prefix의 키는 400 INVALID_REQUEST', async () => {
      const service = await createService(ctx);

      const res = await register(service.serviceId, { ...testKeys('x'), secretKey: 'live_sk_oops' });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('INVALID_REQUEST');
    });

    it('시크릿 키가 빠지면 400 INVALID_REQUEST', async () => {
      const service = await createService(ctx);
      const { environment, merchantId, clientKey } = testKeys('x');

      const res = await register(service.serviceId, { environment, merchantId, clientKey });

      expect(res.status).toBe(400);
      expect(errorOf(res).detail?.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'secretKey' })]),
      );
    });

    it('없는 서비스는 404 RESOURCE_NOT_FOUND', async () => {
      const res = await register('00000000-0000-4000-8000-000000000000', testKeys('x'));

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('비활성', () => {
    it('사유 없이는 400 ADMIN_REASON_REQUIRED, 사유가 있으면 비활성 + 감사 로그', async () => {
      const service = await createService(ctx);
      const credential = dataOf<CredentialData>(await register(service.serviceId, testKeys('d')));
      const url = `/api/v1/admin/pg-credentials/${credential.pgCredentialId}/deactivate`;

      const withoutReason = await ctx.http().post(url).set(adminHeaders);
      const deactivated = await ctx.http().post(url).set(adminHeaders).send({ reason: '키 유출 의심' });
      const again = await ctx.http().post(url).set(adminHeaders).send({ reason: '재시도' });

      expect(errorOf(withoutReason).code).toBe('ADMIN_REASON_REQUIRED');
      expect(deactivated.status).toBe(200);
      expect(dataOf<CredentialData>(deactivated).isActive).toBe(false);
      expect(again.status).toBe(200);
      expect(await auditActionsOf(ctx, credential.pgCredentialId)).toEqual([
        'PG_CREDENTIAL_REGISTERED',
        'PG_CREDENTIAL_DEACTIVATED',
      ]);
    });
  });

  describe('GET /pg/client-config (서비스 API)', () => {
    it('이 배포 환경의 활성 clientKey를 돌려준다 (시크릿 키 없음)', async () => {
      const service = await createService(ctx);
      const apiKey = await issueApiKey(ctx, service.serviceId);
      await register(service.serviceId, testKeys('cfg'));

      const res = await clientConfig(apiKey);

      expect(res.status).toBe(200);
      expect(dataOf<Record<string, unknown>>(res)).toEqual({
        provider: 'TOSS',
        environment: 'TEST',
        clientKey: 'test_ck_cfg',
      });
    });

    it('활성 자격증명이 없으면 500 PG_CREDENTIAL_NOT_FOUND', async () => {
      const service = await createService(ctx);
      const apiKey = await issueApiKey(ctx, service.serviceId);

      const res = await clientConfig(apiKey);

      expect(res.status).toBe(500);
      expect(errorOf(res).code).toBe('PG_CREDENTIAL_NOT_FOUND');
    });

    it('다른 환경(LIVE) 자격증명만 있으면 TEST 배포에서는 쓰지 않는다', async () => {
      const service = await createService(ctx);
      const apiKey = await issueApiKey(ctx, service.serviceId);
      await register(service.serviceId, {
        environment: 'LIVE',
        clientKey: 'live_ck_x',
        secretKey: 'live_sk_x',
      });

      expect(errorOf(await clientConfig(apiKey)).code).toBe('PG_CREDENTIAL_NOT_FOUND');
    });

    it('다른 서비스의 자격증명은 보이지 않는다', async () => {
      const owner = await createService(ctx);
      await register(owner.serviceId, testKeys('owner'));
      const other = await createService(ctx);
      const otherKey = await issueApiKey(ctx, other.serviceId);

      expect(errorOf(await clientConfig(otherKey)).code).toBe('PG_CREDENTIAL_NOT_FOUND');
    });
  });
});
