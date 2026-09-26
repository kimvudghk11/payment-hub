import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import { Encrypted } from '../../common/crypto/encryption.service';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { ServiceStatus } from '../constants/service.constants';

export interface ServiceUpdate {
  name?: string;
  webhookUrl?: string | null;
}

@Entity({ name: 'tb_service' })
export class Service extends BaseEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  serviceId: string;

  /** 'SVC_A' 같은 사람이 읽는 식별자. 전역 유니크 */
  @Column({ name: 'code', type: 'varchar', length: 20 })
  code: string;

  @Column({ name: 'name', type: 'varchar', length: 100 })
  name: string;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status: ServiceStatus;

  /** 결제 이벤트를 받을 서비스 엔드포인트 */
  @Column({ name: 'webhook_url', type: 'text', nullable: true })
  webhookUrl: string | null;

  /** hub → 서비스 웹훅 HMAC 서명 키 (암호화). 응답에 절대 포함 금지 */
  @Column({ name: 'webhook_secret_enc', type: 'bytea', nullable: true })
  webhookSecretEnc: Buffer | null;

  @Column({ name: 'webhook_secret_key_id', type: 'varchar', length: 100, nullable: true })
  webhookSecretKeyId: string | null;

  /** soft delete. 결제 이력은 보존 */
  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  static create(params: { code: string; name: string; webhookUrl?: string | null }): Service {
    const service = new Service();
    service.code = params.code;
    service.name = params.name;
    service.webhookUrl = params.webhookUrl ?? null;
    service.status = ServiceStatus.ACTIVE;
    service.webhookSecretEnc = null;
    service.webhookSecretKeyId = null;
    service.deletedAt = null;
    return service;
  }

  get isDeleted(): boolean {
    return this.deletedAt !== null;
  }

  get isSuspended(): boolean {
    return this.status === ServiceStatus.SUSPENDED;
  }

  /** 서명 키 평문은 호출자가 1회 응답하고, 엔티티는 암호문만 가진다 */
  rotateWebhookSecret(secret: Encrypted): void {
    this.assertNotDeleted();
    this.webhookSecretEnc = secret.ciphertext;
    this.webhookSecretKeyId = secret.keyId;
  }

  /** @returns 실제로 바뀐 필드 이름 */
  update(changes: ServiceUpdate): (keyof ServiceUpdate)[] {
    this.assertNotDeleted();
    const changed: (keyof ServiceUpdate)[] = [];
    if (changes.name !== undefined && changes.name !== this.name) {
      this.name = changes.name;
      changed.push('name');
    }
    if (changes.webhookUrl !== undefined && changes.webhookUrl !== this.webhookUrl) {
      this.webhookUrl = changes.webhookUrl;
      changed.push('webhookUrl');
    }
    return changed;
  }

  /** @returns 상태가 바뀌었으면 true. 이미 정지 상태면 false (멱등) */
  suspend(): boolean {
    this.assertNotDeleted();
    if (this.isSuspended) return false;
    this.status = ServiceStatus.SUSPENDED;
    return true;
  }

  /** @returns 상태가 바뀌었으면 true. 이미 활성 상태면 false (멱등) */
  resume(): boolean {
    this.assertNotDeleted();
    if (!this.isSuspended) return false;
    this.status = ServiceStatus.ACTIVE;
    return true;
  }

  delete(now: Date): void {
    this.assertNotDeleted();
    this.deletedAt = now;
  }

  /** 감사 로그 before/after. 비밀값(서명 키) 제외 */
  auditSnapshot(): Record<string, unknown> {
    return {
      code: this.code,
      name: this.name,
      status: this.status,
      webhookUrl: this.webhookUrl,
      deletedAt: this.deletedAt,
    };
  }

  /** 삭제된 서비스는 관리 대상에서 사라진 것으로 본다 */
  private assertNotDeleted(): void {
    if (this.isDeleted) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
  }
}
