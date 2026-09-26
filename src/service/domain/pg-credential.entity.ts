import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Encrypted } from '../../common/crypto/encryption.service';
import { BaseEntity } from '../../common/domain/base.entity';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PgProvider } from '../../pg/constants/pg.constants';
import { PgEnvironment } from '../constants/service.constants';

/** 서비스·환경(TEST/LIVE)별 토스 자격증명. (service, provider, environment)당 활성 1개 */
@Entity({ name: 'tb_pg_credential' })
export class PgCredential extends BaseEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  pgCredentialId: string;

  @Column({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  @Column({ name: 'provider', type: 'varchar', length: 20 })
  provider: PgProvider;

  @Column({ name: 'environment', type: 'varchar', length: 10 })
  environment: PgEnvironment;

  /** 토스 mId */
  @Column({ name: 'merchant_id', type: 'varchar', length: 100, nullable: true })
  merchantId: string | null;

  /** 공개 키. 서비스 프론트가 결제창 띄울 때 사용 */
  @Column({ name: 'client_key', type: 'varchar', length: 200, nullable: true })
  clientKey: string | null;

  /** 토스 시크릿 키 (암호화). 어떤 응답에도 반환 금지 */
  @Column({ name: 'secret_key_enc', type: 'bytea' })
  secretKeyEnc: Buffer;

  /** 암호화에 쓴 KMS 키 / 버전 */
  @Column({ name: 'secret_key_id', type: 'varchar', length: 100 })
  secretKeyId: string;

  @Column({ name: 'secret_key_hint', type: 'char', length: 4 })
  secretKeyHint: string;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive: boolean;

  /**
   * 토스 키 등록. 시크릿 키 평문은 암호화에만 쓰고 필드에 남기지 않는다.
   * 토스 키는 prefix로 환경이 갈리므로(test_ / live_) 환경과 다르면 거부한다.
   */
  static register(params: {
    serviceId: string;
    environment: PgEnvironment;
    merchantId: string | null;
    clientKey: string;
    secretKey: string;
    encrypt: (plaintext: string) => Encrypted;
  }): PgCredential {
    const expectedPrefix = TOSS_KEY_PREFIX[params.environment];
    const mismatched = (
      [
        ['clientKey', params.clientKey],
        ['secretKey', params.secretKey],
      ] as const
    ).filter(([, key]) => !key.startsWith(expectedPrefix));
    if (mismatched.length > 0) {
      throw new BusinessException(ErrorCode.INVALID_REQUEST, {
        errors: mismatched.map(([field]) => ({
          field,
          message: `${params.environment} 환경에는 ${expectedPrefix}로 시작하는 키만 등록할 수 있습니다.`,
        })),
      });
    }

    const encrypted = params.encrypt(params.secretKey);
    const credential = new PgCredential();
    credential.serviceId = params.serviceId;
    credential.provider = PgProvider.TOSS;
    credential.environment = params.environment;
    credential.merchantId = params.merchantId;
    credential.clientKey = params.clientKey;
    credential.secretKeyEnc = encrypted.ciphertext;
    credential.secretKeyId = encrypted.keyId;
    credential.secretKeyHint = params.secretKey.slice(-4);
    credential.isActive = true;
    return credential;
  }

  /** @returns 이번에 비활성화했으면 true. 이미 비활성이면 false (멱등) */
  deactivate(): boolean {
    if (!this.isActive) return false;
    this.isActive = false;
    return true;
  }

  /** 감사 로그 before/after. 시크릿 키 암호문 제외 */
  auditSnapshot(): Record<string, unknown> {
    return {
      environment: this.environment,
      merchantId: this.merchantId,
      clientKey: this.clientKey,
      secretKeyHint: this.secretKeyHint,
      isActive: this.isActive,
    };
  }
}

const TOSS_KEY_PREFIX: Record<PgEnvironment, string> = {
  [PgEnvironment.TEST]: 'test_',
  [PgEnvironment.LIVE]: 'live_',
};
