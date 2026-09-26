import {
  IntegrationApp,
  adminHeaders,
  createIntegrationApp,
  dataOf,
  errorOf,
  uniqueServiceCode,
} from '../support/integration-app';

interface IssuedKey {
  apiKeyId: string;
  apiKey: string;
  keyPrefix: string;
  keyHint: string;
}
interface KeyData {
  apiKeyId: string;
  keyHint: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

describe('서비스 API 키 발급·인증 (ApiKeyGuard)', () => {
  let ctx: IntegrationApp;

  beforeAll(async () => {
    ctx = await createIntegrationApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const createService = async () => {
    const res = await ctx
      .http()
      .post('/api/v1/admin/services')
      .set(adminHeaders)
      .send({ code: uniqueServiceCode(), name: '서비스 A' });
    return dataOf<{ serviceId: string; code: string }>(res);
  };

  const issueKey = async (serviceId: string, body: Record<string, unknown> = { label: 'prod-server-1' }) => {
    const res = await ctx.http().post(`/api/v1/admin/services/${serviceId}/api-keys`).set(adminHeaders).send(body);
    expect(res.status).toBe(201);
    return dataOf<IssuedKey>(res);
  };

  const me = (apiKey?: string) => {
    const req = ctx.http().get('/api/v1/me');
    return apiKey ? req.set('Authorization', `Bearer ${apiKey}`) : req;
  };

  describe('발급', () => {
    it('TEST 배포는 ph_test_ 키를 발급하고, DB에는 해시만 저장한다', async () => {
      const service = await createService();

      const key = await issueKey(service.serviceId);

      expect(key.apiKey).toMatch(/^ph_test_/);
      expect(key.keyHint).toBe(key.apiKey.slice(-4));
      const rows = await ctx.dataSource.query<{ key_hash: string }[]>(
        'SELECT key_hash FROM tb_service_api_key WHERE id = $1',
        [key.apiKeyId],
      );
      expect(rows[0].key_hash).not.toContain(key.apiKey);
      const audit = await ctx.dataSource.query<{ action: string; after: unknown }[]>(
        'SELECT action, after FROM tb_admin_audit_log WHERE target_id = $1',
        [key.apiKeyId],
      );
      expect(audit).toEqual([expect.objectContaining({ action: 'API_KEY_ISSUED' })]);
      expect(JSON.stringify(audit)).not.toContain(rows[0].key_hash);
    });

    it('목록에는 평문·해시 없이 hint와 사용 이력만 나온다', async () => {
      const service = await createService();
      const key = await issueKey(service.serviceId);

      const res = await ctx.http().get(`/api/v1/admin/services/${service.serviceId}/api-keys`).set(adminHeaders);

      expect(dataOf<KeyData[]>(res)).toEqual([
        expect.objectContaining({ apiKeyId: key.apiKeyId, keyHint: key.keyHint, revokedAt: null }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain(key.apiKey);
      expect(JSON.stringify(res.body)).not.toMatch(/hash/i);
    });

    it('삭제된 서비스에는 발급할 수 없다 (404)', async () => {
      const service = await createService();
      await ctx.http().delete(`/api/v1/admin/services/${service.serviceId}`).set(adminHeaders).send({ reason: '종료' });

      const res = await ctx
        .http()
        .post(`/api/v1/admin/services/${service.serviceId}/api-keys`)
        .set(adminHeaders)
        .send({ label: 'x' });

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('GET /me — 서비스 API 인증', () => {
    it('유효한 키면 호출한 서비스 정보를 돌려주고 last_used_at을 갱신한다', async () => {
      const service = await createService();
      const key = await issueKey(service.serviceId);

      const res = await me(key.apiKey);

      expect(res.status).toBe(200);
      expect(dataOf<{ serviceId: string; code: string }>(res)).toMatchObject({
        serviceId: service.serviceId,
        code: service.code,
      });
      await expect(waitForLastUsed(key.apiKeyId)).resolves.not.toBeNull();
    });

    it('키가 없거나 등록되지 않은 키면 401 UNAUTHORIZED', async () => {
      for (const res of [await me(), await me('ph_test_not-a-registered-key')]) {
        expect(res.status).toBe(401);
        expect(errorOf(res).code).toBe('UNAUTHORIZED');
      }
    });

    it('admin 키로는 서비스 API를 호출할 수 없다', async () => {
      const res = await ctx.http().get('/api/v1/me').set(adminHeaders);

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('UNAUTHORIZED');
    });

    it('서비스 API 키로는 관리자 API를 호출할 수 없다', async () => {
      const service = await createService();
      const key = await issueKey(service.serviceId);

      const res = await ctx
        .http()
        .get('/api/v1/admin/services')
        .set({ Authorization: `Bearer ${key.apiKey}`, 'X-Admin-Actor-Id': 'x' });

      expect(res.status).toBe(401);
    });

    it('폐기된 키는 401 API_KEY_REVOKED, 다시 폐기해도 200이고 감사 로그는 한 번', async () => {
      const service = await createService();
      const key = await issueKey(service.serviceId);
      const revoke = () => ctx.http().post(`/api/v1/admin/api-keys/${key.apiKeyId}/revoke`).set(adminHeaders);

      expect((await revoke()).status).toBe(200);
      expect((await revoke()).status).toBe(200);
      const res = await me(key.apiKey);

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('API_KEY_REVOKED');
      const audit = await ctx.dataSource.query<{ action: string }[]>(
        `SELECT action FROM tb_admin_audit_log WHERE target_id = $1 AND action = 'API_KEY_REVOKED'`,
        [key.apiKeyId],
      );
      expect(audit).toHaveLength(1);
    });

    it('만료된 키는 401 API_KEY_EXPIRED', async () => {
      const service = await createService();
      const key = await issueKey(service.serviceId, {
        label: 'short',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      // 시간 경과를 흉내 내기 위해 테스트 셋업에서만 만료 시각을 과거로 옮긴다
      await ctx.dataSource.query(
        `UPDATE tb_service_api_key SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [key.apiKeyId],
      );

      const res = await me(key.apiKey);

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('API_KEY_EXPIRED');
    });

    it('정지된 서비스는 키가 유효해도 403 SERVICE_SUSPENDED, 재개하면 다시 통과', async () => {
      const service = await createService();
      const key = await issueKey(service.serviceId);
      const base = `/api/v1/admin/services/${service.serviceId}`;

      await ctx.http().post(`${base}/suspend`).set(adminHeaders).send({ reason: '조사' });
      const suspended = await me(key.apiKey);
      await ctx.http().post(`${base}/resume`).set(adminHeaders);
      const resumed = await me(key.apiKey);

      expect(suspended.status).toBe(403);
      expect(errorOf(suspended).code).toBe('SERVICE_SUSPENDED');
      expect(resumed.status).toBe(200);
    });

    it('삭제된 서비스의 키는 401 UNAUTHORIZED', async () => {
      const service = await createService();
      const key = await issueKey(service.serviceId);
      await ctx.http().delete(`/api/v1/admin/services/${service.serviceId}`).set(adminHeaders).send({ reason: '종료' });

      const res = await me(key.apiKey);

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('UNAUTHORIZED');
    });
  });

  /** last_used_at은 응답과 별개로 비동기 갱신된다 */
  const waitForLastUsed = async (apiKeyId: string): Promise<Date | null> => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const [row] = await ctx.dataSource.query<{ last_used_at: Date | null }[]>(
        'SELECT last_used_at FROM tb_service_api_key WHERE id = $1',
        [apiKeyId],
      );
      if (row.last_used_at) return row.last_used_at;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  };
});
