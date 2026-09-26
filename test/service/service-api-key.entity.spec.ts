import { createHash } from 'crypto';
import { PgEnvironment } from '../../src/service/constants/service.constants';
import { ServiceApiKey } from '../../src/service/domain/service-api-key.entity';
import { expectBusinessError } from '../support/business-error';

const NOW = new Date('2026-09-26T00:00:00.000Z');
const LATER = new Date('2027-09-26T00:00:00.000Z');

const issue = (overrides: Partial<Parameters<typeof ServiceApiKey.issue>[0]> = {}) =>
  ServiceApiKey.issue({
    serviceId: 'svc-1',
    label: 'prod-server-1',
    expiresAt: null,
    environment: PgEnvironment.LIVE,
    now: NOW,
    ...overrides,
  });

describe('ServiceApiKey', () => {
  describe('issue', () => {
    it('환경별 prefix가 붙은 평문 키를 한 번만 돌려주고, 엔티티에는 해시만 둔다', () => {
      const { apiKey, plaintext } = issue();

      expect(plaintext).toMatch(/^ph_live_[A-Za-z0-9_-]{43}$/);
      expect(apiKey.keyPrefix).toBe('ph_live_');
      expect(apiKey.keyHint).toBe(plaintext.slice(-4));
      expect(apiKey.keyHash).toBe(createHash('sha256').update(plaintext).digest('hex'));
      expect(Object.values(apiKey)).not.toContain(plaintext);
    });

    it('TEST 환경은 ph_test_ prefix', () => {
      expect(issue({ environment: PgEnvironment.TEST }).plaintext).toMatch(/^ph_test_/);
    });

    it('매번 다른 키를 만든다', () => {
      expect(issue().plaintext).not.toBe(issue().plaintext);
    });

    it('만료 시각이 이미 지났으면 400 INVALID_REQUEST', () => {
      expectBusinessError(() => issue({ expiresAt: NOW }), 'INVALID_REQUEST');
    });
  });

  describe('hash', () => {
    it('발급 시 저장한 해시와 같은 값으로 조회할 수 있다', () => {
      const { apiKey, plaintext } = issue();

      expect(ServiceApiKey.hash(plaintext)).toBe(apiKey.keyHash);
    });
  });

  describe('만료·폐기', () => {
    it('expiresAt이 없으면 만료되지 않는다', () => {
      expect(issue().apiKey.isExpired(LATER)).toBe(false);
    });

    it('expiresAt 시각부터 만료로 본다', () => {
      const { apiKey } = issue({ expiresAt: LATER });

      expect(apiKey.isExpired(new Date(LATER.getTime() - 1))).toBe(false);
      expect(apiKey.isExpired(LATER)).toBe(true);
    });

    it('revoke는 처음 한 번만 폐기 시각을 기록한다 (멱등)', () => {
      const { apiKey } = issue();

      expect(apiKey.revoke(NOW)).toBe(true);
      expect(apiKey.revoke(LATER)).toBe(false);
      expect(apiKey.revokedAt).toEqual(NOW);
      expect(apiKey.isRevoked).toBe(true);
    });
  });

  describe('auditSnapshot', () => {
    it('해시를 포함하지 않는다', () => {
      const { apiKey } = issue();

      expect(apiKey.auditSnapshot()).toEqual({
        label: 'prod-server-1',
        keyPrefix: 'ph_live_',
        keyHint: apiKey.keyHint,
        expiresAt: null,
        revokedAt: null,
      });
    });
  });
});
