import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Encrypted {
  /** iv(12) | authTag(16) | ciphertext — `*_enc bytea` 컬럼에 그대로 저장 */
  ciphertext: Buffer;
  /** 암호화에 쓴 키 버전 — `*_key_id` 컬럼에 저장 (키 교체 후에도 복호화 가능) */
  keyId: string;
}

/**
 * 비밀값(토스 시크릿 키, 빌링키, 웹훅 서명 키) 암호화. AES-256-GCM + 버전 키링.
 * - ENCRYPTION_KEYS: `v1:<base64 32바이트>,v2:<base64 32바이트>`
 * - ENCRYPTION_KEY_ID: 새로 암호화할 때 쓰는 키 버전
 * 설정이 잘못되면 생성자에서 실패해 부팅을 막는다. 키 값은 에러 메시지에 넣지 않는다.
 */
export class EncryptionService {
  private readonly keys: Map<string, Buffer>;

  constructor(
    keyring: string,
    private readonly currentKeyId: string,
  ) {
    this.keys = parseKeyring(keyring);
    if (!this.keys.has(currentKeyId)) {
      throw new Error(`ENCRYPTION_KEY_ID(${currentKeyId})가 ENCRYPTION_KEYS에 없습니다.`);
    }
  }

  encrypt(plaintext: string): Encrypted {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.keyOf(this.currentKeyId), iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]), keyId: this.currentKeyId };
  }

  decrypt(ciphertext: Buffer, keyId: string): string {
    const iv = ciphertext.subarray(0, IV_BYTES);
    const tag = ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.keyOf(keyId), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString(
      'utf8',
    );
  }

  private keyOf(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`암호화 키 ${keyId}가 키링에 없습니다.`);
    return key;
  }
}

const parseKeyring = (keyring: string): Map<string, Buffer> => {
  const entries = keyring
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error('ENCRYPTION_KEYS가 비어 있습니다.');

  const keys = new Map<string, Buffer>();
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    const keyId = entry.slice(0, separator);
    const key = Buffer.from(entry.slice(separator + 1), 'base64');
    if (separator <= 0 || key.length !== KEY_BYTES) {
      throw new Error(`ENCRYPTION_KEYS 항목은 '<keyId>:<base64 ${KEY_BYTES}바이트>' 형식이어야 합니다.`);
    }
    if (keys.has(keyId)) throw new Error(`ENCRYPTION_KEYS에 키 ID ${keyId}가 중복되었습니다.`);
    keys.set(keyId, key);
  }
  return keys;
};
