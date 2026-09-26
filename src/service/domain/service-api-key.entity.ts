import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { CreatedAtEntity } from '../../common/domain/created-at.entity';

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
}
