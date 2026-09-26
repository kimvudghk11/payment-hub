import { createHash, randomBytes } from 'crypto';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { CreatedAtEntity } from '../../common/domain/created-at.entity';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PgEnvironment } from '../constants/service.constants';

const KEY_PREFIX: Record<PgEnvironment, string> = {
  [PgEnvironment.TEST]: 'ph_test_',
  [PgEnvironment.LIVE]: 'ph_live_',
};
const KEY_RANDOM_BYTES = 32;

/** 서비스 → hub 인증 키. 서비스당 여러 개 허용(무중단 교체). 평문은 저장하지 않는다. */
@Entity({ name: 'tb_service_api_key' })
export class ServiceApiKey extends CreatedAtEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  serviceApiKeyId: string;

  @Column({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  /** 'prod-server-1', 'batch' 등 */
  @Column({ name: 'label', type: 'varchar', length: 50 })
  label: string;

  /** 'ph_live_' / 'ph_test_'. 환경 구분 + 로그 식별용 */
  @Column({ name: 'key_prefix', type: 'varchar', length: 12 })
  keyPrefix: string;

  /** 마지막 4자리. 어드민 표시용 */
  @Column({ name: 'key_hint', type: 'char', length: 4 })
  keyHint: string;

  /** SHA-256 hex. 응답에 절대 포함 금지 */
  @Column({ name: 'key_hash', type: 'char', length: 64 })
  keyHash: string;

  /** null = 만료 없음 */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  /** null = 유효 */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /**
   * 새 키 발급. 평문은 이 반환값으로 1회만 전달하고 엔티티에는 해시만 남긴다.
   */
  static issue(params: {
    serviceId: string;
    label: string;
    expiresAt: Date | null;
    environment: PgEnvironment;
    now: Date;
  }): { apiKey: ServiceApiKey; plaintext: string } {
    if (params.expiresAt && params.expiresAt <= params.now) {
      throw new BusinessException(ErrorCode.INVALID_REQUEST, {
        errors: [{ field: 'expiresAt', message: 'expiresAt는 현재 시각 이후여야 합니다.' }],
      });
    }

    const prefix = KEY_PREFIX[params.environment];
    const plaintext = `${prefix}${randomBytes(KEY_RANDOM_BYTES).toString('base64url')}`;

    const apiKey = new ServiceApiKey();
    apiKey.serviceId = params.serviceId;
    apiKey.label = params.label;
    apiKey.keyPrefix = prefix;
    apiKey.keyHint = plaintext.slice(-4);
    apiKey.keyHash = ServiceApiKey.hash(plaintext);
    apiKey.expiresAt = params.expiresAt;
    apiKey.lastUsedAt = null;
    apiKey.revokedAt = null;
    return { apiKey, plaintext };
  }

  static hash(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
  }

  get isRevoked(): boolean {
    return this.revokedAt !== null;
  }

  isExpired(now: Date): boolean {
    return this.expiresAt !== null && this.expiresAt <= now;
  }

  /** @returns 이번에 폐기했으면 true. 이미 폐기된 키면 false (멱등, 최초 폐기 시각 유지) */
  revoke(now: Date): boolean {
    if (this.isRevoked) return false;
    this.revokedAt = now;
    return true;
  }

  /** 감사 로그 before/after. 해시 제외 */
  auditSnapshot(): Record<string, unknown> {
    return {
      label: this.label,
      keyPrefix: this.keyPrefix,
      keyHint: this.keyHint,
      expiresAt: this.expiresAt,
      revokedAt: this.revokedAt,
    };
  }
}
