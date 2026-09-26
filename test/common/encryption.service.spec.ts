import { randomBytes } from 'crypto';
import { EncryptionService } from '../../src/common/crypto/encryption.service';

const key = () => randomBytes(32).toString('base64');

describe('EncryptionService (AES-256-GCM 키링)', () => {
  const v1 = key();
  const v2 = key();

  it('현재 키 ID로 암호화하고 같은 키 ID로 복호화한다', () => {
    const service = new EncryptionService(`v1:${v1},v2:${v2}`, 'v2');

    const encrypted = service.encrypt('live_sk_secret');

    expect(encrypted.keyId).toBe('v2');
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('live_sk_secret');
    expect(service.decrypt(encrypted.ciphertext, encrypted.keyId)).toBe('live_sk_secret');
  });

  it('같은 평문도 매번 다른 암호문이 나온다 (랜덤 IV)', () => {
    const service = new EncryptionService(`v1:${v1}`, 'v1');

    expect(service.encrypt('same').ciphertext.equals(service.encrypt('same').ciphertext)).toBe(false);
  });

  it('키 교체 후에도 이전 키로 암호화한 값을 복호화한다', () => {
    const before = new EncryptionService(`v1:${v1}`, 'v1').encrypt('old-secret');
    const after = new EncryptionService(`v1:${v1},v2:${v2}`, 'v2');

    expect(after.decrypt(before.ciphertext, 'v1')).toBe('old-secret');
  });

  it('암호문이 변조되면 복호화를 거부한다 (GCM 인증 태그)', () => {
    const service = new EncryptionService(`v1:${v1}`, 'v1');
    const { ciphertext } = service.encrypt('secret');
    ciphertext[ciphertext.length - 1] ^= 0xff;

    expect(() => service.decrypt(ciphertext, 'v1')).toThrow();
  });

  it('키링에 없는 키 ID로는 복호화하지 않는다', () => {
    const service = new EncryptionService(`v1:${v1}`, 'v1');

    expect(() => service.decrypt(service.encrypt('x').ciphertext, 'v9')).toThrow(/v9/);
  });

  describe('설정 검증 (부팅 시점)', () => {
    it('현재 키 ID가 키링에 없으면 실패한다', () => {
      expect(() => new EncryptionService(`v1:${v1}`, 'v2')).toThrow(/ENCRYPTION_KEY_ID/);
    });

    it('32바이트가 아닌 키가 있으면 실패한다', () => {
      expect(() => new EncryptionService(`v1:${randomBytes(16).toString('base64')}`, 'v1')).toThrow(/ENCRYPTION_KEYS/);
    });

    it('키링이 비어 있으면 실패한다', () => {
      expect(() => new EncryptionService('', 'v1')).toThrow(/ENCRYPTION_KEYS/);
    });

    it('키 ID가 중복되면 실패한다', () => {
      expect(() => new EncryptionService(`v1:${v1},v1:${v2}`, 'v1')).toThrow(/ENCRYPTION_KEYS/);
    });
  });
});
