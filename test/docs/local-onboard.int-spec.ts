import { AddressInfo } from 'net';
import { generateAdminKey } from '../../scripts/generate-admin-key';
import { onboardLocalService } from '../../scripts/local-onboard';
import { ADMIN_KEY, IntegrationApp, createIntegrationApp, uniqueServiceCode } from '../support/integration-app';
import { createHash } from 'crypto';

/** README·가이드가 안내하는 로컬 연동 준비 스크립트가 실제 hub에서 동작하는지 */
describe('로컬 연동 스크립트 (scripts/)', () => {
  let ctx: IntegrationApp;
  let hubUrl: string;

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    await ctx.app.listen(0, '127.0.0.1');
    const server = ctx.app.getHttpServer() as unknown as { address(): AddressInfo };
    hubUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('generate-admin-key', () => {
    it('평문 키와, hub env에 넣을 SHA-256 해시를 만든다', () => {
      const { adminKey, hash } = generateAdminKey();

      expect(adminKey).toMatch(/^phadm_[A-Za-z0-9_-]{43}$/);
      expect(hash).toBe(createHash('sha256').update(adminKey).digest('hex'));
    });
  });

  describe('local-onboard', () => {
    const options = (serviceCode: string) => ({
      hubUrl,
      adminApiKey: ADMIN_KEY,
      serviceCode,
      serviceName: '로컬 테스트 서비스',
      webhookUrl: 'http://localhost:4000/webhooks/payment-hub',
      productTypes: [
        { code: 'PLAN', name: '구독 요금제' },
        { code: 'ADDON', name: '부가 상품' },
      ],
      tossClientKey: 'test_ck_local',
      tossSecretKey: 'test_sk_local',
    });

    it('서비스·상품 유형·PG 자격증명·API 키를 준비하고, 서비스 .env 값을 돌려준다', async () => {
      const result = await onboardLocalService(options(uniqueServiceCode()));

      expect(result.created).toBe(true);
      expect(result.env).toEqual({
        PAYMENT_HUB_URL: hubUrl,
        PAYMENT_HUB_API_KEY: expect.stringMatching(/^ph_test_/) as unknown,
        PAYMENT_HUB_WEBHOOK_SECRET: expect.stringMatching(/^whsec_/) as unknown,
      });
      expect(result.verified).toEqual({ serviceCode: expect.any(String) as unknown, clientKey: 'test_ck_local' });
    });

    it('다시 실행하면 기존 서비스를 재사용하고 새 API 키만 발급한다 (웹훅 키는 교체하지 않음)', async () => {
      const code = uniqueServiceCode();
      const first = await onboardLocalService(options(code));

      const second = await onboardLocalService(options(code));

      expect(second.created).toBe(false);
      expect(second.serviceId).toBe(first.serviceId);
      expect(second.env.PAYMENT_HUB_API_KEY).not.toBe(first.env.PAYMENT_HUB_API_KEY);
      expect(second.env.PAYMENT_HUB_WEBHOOK_SECRET).toBeUndefined();
    });

    it('토스 테스트 키가 없으면 PG 등록을 건너뛰고 알려준다', async () => {
      const result = await onboardLocalService({
        ...options(uniqueServiceCode()),
        tossClientKey: undefined,
        tossSecretKey: undefined,
      });

      expect(result.verified.clientKey).toBeNull();
      expect(result.warnings).toEqual([expect.stringContaining('TOSS_CLIENT_KEY')]);
    });
  });
});
