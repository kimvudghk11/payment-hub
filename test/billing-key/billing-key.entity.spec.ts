import { BillingKeyStatus } from '../../src/billing-key/constants/billing-key.constants';
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

  it('usableBy: 활성이고 같은 사용자일 때만 자동결제에 쓸 수 있다', () => {
    const key = issue();
    expect(key.usableBy('user-1')).toBe(true);
    expect(key.usableBy('user-2')).toBe(false);
    key.revoke(new Date());
    expect(key.usableBy('user-1')).toBe(false);
  });
});
