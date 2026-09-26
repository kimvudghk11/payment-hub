import { Encrypted } from '../../src/common/crypto/encryption.service';
import { PgProvider } from '../../src/pg/constants/pg.constants';
import { PgEnvironment } from '../../src/service/constants/service.constants';
import { PgCredential } from '../../src/service/domain/pg-credential.entity';
import { expectBusinessError } from '../support/business-error';

/** 테스트용 암호화: 평문이 암호문에 그대로 들어가지 않는지만 구분할 수 있으면 된다 */
const fakeEncrypt = (plaintext: string): Encrypted => ({
  ciphertext: Buffer.from(plaintext.split('').reverse().join('')),
  keyId: 'v1',
});

const register = (overrides: Partial<Parameters<typeof PgCredential.register>[0]> = {}) =>
  PgCredential.register({
    serviceId: 'svc-1',
    environment: PgEnvironment.LIVE,
    merchantId: 'tosspayments_mid',
    clientKey: 'live_ck_abcdefgh',
    secretKey: 'live_sk_supersecret1234',
    encrypt: fakeEncrypt,
    ...overrides,
  });

describe('PgCredential', () => {
  describe('register', () => {
    it('시크릿 키는 암호문과 끝 4자리 hint로만 보관하고 활성 상태로 만든다', () => {
      const credential = register();

      expect(credential).toMatchObject({
        serviceId: 'svc-1',
        provider: PgProvider.TOSS,
        environment: PgEnvironment.LIVE,
        merchantId: 'tosspayments_mid',
        clientKey: 'live_ck_abcdefgh',
        secretKeyId: 'v1',
        secretKeyHint: '1234',
        isActive: true,
      });
      expect(credential.secretKeyEnc.toString()).not.toContain('live_sk_supersecret1234');
      expect(Object.values(credential)).not.toContain('live_sk_supersecret1234');
    });

    it('TEST 환경은 test_ 키만 받는다', () => {
      const credential = register({
        environment: PgEnvironment.TEST,
        clientKey: 'test_ck_abc',
        secretKey: 'test_sk_abc1',
      });

      expect(credential.environment).toBe(PgEnvironment.TEST);
    });

    it.each([
      ['LIVE 환경에 test_ 시크릿 키', { secretKey: 'test_sk_abc1' }],
      ['LIVE 환경에 test_ 클라이언트 키', { clientKey: 'test_ck_abc' }],
      ['TEST 환경에 live_ 키', { environment: PgEnvironment.TEST, clientKey: 'test_ck_a', secretKey: 'live_sk_a1' }],
    ])('%s는 400 INVALID_REQUEST (환경 혼동 방지)', (_, overrides) => {
      expectBusinessError(() => register(overrides), 'INVALID_REQUEST');
    });
  });

  describe('deactivate', () => {
    it('활성 → 비활성, 이미 비활성이면 false (멱등)', () => {
      const credential = register();

      expect(credential.deactivate()).toBe(true);
      expect(credential.isActive).toBe(false);
      expect(credential.deactivate()).toBe(false);
    });
  });

  describe('auditSnapshot', () => {
    it('시크릿 키 암호문을 포함하지 않는다', () => {
      expect(register().auditSnapshot()).toEqual({
        environment: 'LIVE',
        merchantId: 'tosspayments_mid',
        clientKey: 'live_ck_abcdefgh',
        secretKeyHint: '1234',
        isActive: true,
      });
    });
  });
});
