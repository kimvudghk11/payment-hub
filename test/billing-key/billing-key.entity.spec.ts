import {
  BILLING_KEY_PG_DELETE_MAX_ATTEMPTS,
  BillingKeyStatus,
} from '../../src/billing-key/constants/billing-key.constants';
import { BillingKey } from '../../src/billing-key/domain/billing-key.entity';

const encrypt = (plaintext: string) => ({ ciphertext: Buffer.from(`enc(${plaintext})`), keyId: 'v1' });

describe('BillingKey', () => {
  const issue = () =>
    BillingKey.issue({
      serviceId: 'svc-1',
      externalUserId: 'user-1',
      customerKey: 'c_8f2a',
      billingKey: 'bk_plain_secret',
      cardCompany: '현대',
      cardNumberMasked: '433012******1234',
      encrypt,
    });

  it('issue: 빌링키는 암호문으로만 들고, 원문은 어떤 필드에도 남기지 않는다', () => {
    const key = issue();

    expect(key).toMatchObject({
      serviceId: 'svc-1',
      externalUserId: 'user-1',
      provider: 'TOSS',
      customerKey: 'c_8f2a',
      billingKeyKeyId: 'v1',
      cardCompany: '현대',
      cardNumberMasked: '433012******1234',
      status: BillingKeyStatus.ACTIVE,
      revokedAt: null,
    });
    expect(key.billingKeyEnc.toString()).toBe('enc(bk_plain_secret)');
    expect(JSON.stringify({ ...key, billingKeyEnc: undefined })).not.toContain('bk_plain_secret');
  });

  it('revoke: ACTIVE → REVOKED, 폐기 시각 기록 → true. 이미 폐기면 false (멱등)', () => {
    const key = issue();
    const now = new Date('2026-09-28T00:00:00.000Z');

    expect(key.revoke(now)).toBe(true);
    expect(key).toMatchObject({ status: BillingKeyStatus.REVOKED, revokedAt: now });
    expect(key.revoke(new Date())).toBe(false);
    expect(key.revokedAt).toBe(now);
  });

  it('issue: 토스 삭제 전 상태로 시작한다', () => {
    expect(issue()).toMatchObject({ pgDeletedAt: null, pgDeleteAttemptCount: 0 });
  });

  it('needsPgDeletion: 폐기됐고 토스 삭제 전이며 시도 한도 미만일 때만 true', () => {
    const key = issue();
    expect(key.needsPgDeletion).toBe(false);

    key.revoke(new Date());
    expect(key.needsPgDeletion).toBe(true);

    for (let i = 0; i < BILLING_KEY_PG_DELETE_MAX_ATTEMPTS; i += 1) key.recordPgDeleteFailure();
    expect(key.pgDeleteAttemptCount).toBe(BILLING_KEY_PG_DELETE_MAX_ATTEMPTS);
    expect(key.needsPgDeletion).toBe(false);
  });

  it('markPgDeleted: 폐기된 키에 토스 삭제 시각을 기록 → true. 이미 기록됐으면 false (멱등)', () => {
    const key = issue();
    key.revoke(new Date());
    const now = new Date('2026-09-28T00:00:00.000Z');

    expect(key.markPgDeleted(now)).toBe(true);
    expect(key.pgDeletedAt).toBe(now);
    expect(key.needsPgDeletion).toBe(false);
    expect(key.markPgDeleted(new Date())).toBe(false);
    expect(key.pgDeletedAt).toBe(now);
  });

  it('활성 키는 토스에서 삭제될 수 없다 (hub에서 먼저 폐기해야 한다)', () => {
    const key = issue();
    expect(() => key.markPgDeleted(new Date())).toThrow();
    expect(() => key.recordPgDeleteFailure()).toThrow();
  });

  it('usableBy: 활성이고 같은 사용자일 때만 자동결제에 쓸 수 있다', () => {
    const key = issue();
    expect(key.usableBy('user-1')).toBe(true);
    expect(key.usableBy('user-2')).toBe(false);
    key.revoke(new Date());
    expect(key.usableBy('user-1')).toBe(false);
  });
});
