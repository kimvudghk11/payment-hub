import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Encrypted } from '../../common/crypto/encryption.service';
import { BaseEntity } from '../../common/domain/base.entity';
import { PgProvider } from '../../pg/constants/pg.constants';
import { BILLING_KEY_PG_DELETE_MAX_ATTEMPTS, BillingKeyStatus } from '../constants/billing-key.constants';

/** 자동결제 수단. 빌링키는 시크릿 키와 합쳐지면 결제가 가능하므로 암호화 저장 */
@Entity({ name: 'tb_billing_key' })
export class BillingKey extends BaseEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  billingKeyId: string;

  @Column({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  /** 서비스의 사용자 ID */
  @Column({ name: 'external_user_id', type: 'varchar', length: 100 })
  externalUserId: string;

  @Column({ name: 'provider', type: 'varchar', length: 20 })
  provider: PgProvider;

  /** 토스 customerKey */
  @Column({ name: 'customer_key', type: 'varchar', length: 300 })
  customerKey: string;

  /** 빌링키 (암호화). 응답·로그에 절대 포함 금지 */
  @Column({ name: 'billing_key_enc', type: 'bytea' })
  billingKeyEnc: Buffer;

  @Column({ name: 'billing_key_key_id', type: 'varchar', length: 100 })
  billingKeyKeyId: string;

  @Column({ name: 'card_company', type: 'varchar', length: 50, nullable: true })
  cardCompany: string | null;

  /** 예: 1234-****-****-5678 */
  @Column({ name: 'card_number_masked', type: 'varchar', length: 30, nullable: true })
  cardNumberMasked: string | null;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status: BillingKeyStatus;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /** 토스 쪽 빌링키 삭제 확인 시각. hub 폐기 뒤 토스에서도 지운다 */
  @Column({ name: 'pg_deleted_at', type: 'timestamptz', nullable: true })
  pgDeletedAt: Date | null;

  @Column({ name: 'pg_delete_attempt_count', type: 'integer' })
  pgDeleteAttemptCount: number;

  /** 토스 발급 결과 저장. 빌링키 원문은 암호화에만 쓰고 필드에 남기지 않는다 */
  static issue(params: {
    serviceId: string;
    externalUserId: string;
    customerKey: string;
    billingKey: string;
    cardCompany: string | null;
    cardNumberMasked: string | null;
    encrypt: (plaintext: string) => Encrypted;
  }): BillingKey {
    const encrypted = params.encrypt(params.billingKey);
    const key = new BillingKey();
    key.serviceId = params.serviceId;
    key.externalUserId = params.externalUserId;
    key.provider = PgProvider.TOSS;
    key.customerKey = params.customerKey;
    key.billingKeyEnc = encrypted.ciphertext;
    key.billingKeyKeyId = encrypted.keyId;
    key.cardCompany = params.cardCompany;
    key.cardNumberMasked = params.cardNumberMasked;
    key.status = BillingKeyStatus.ACTIVE;
    key.revokedAt = null;
    key.pgDeletedAt = null;
    key.pgDeleteAttemptCount = 0;
    return key;
  }

  /** @returns 이번에 폐기했으면 true. 이미 폐기면 false (멱등) */
  revoke(now: Date): boolean {
    if (this.status === BillingKeyStatus.REVOKED) return false;
    this.status = BillingKeyStatus.REVOKED;
    this.revokedAt = now;
    return true;
  }

  /** 토스 삭제를 (다시) 시도해야 하는지: 폐기됐고, 아직 삭제 확인 전이며, 시도 한도 미만 */
  get needsPgDeletion(): boolean {
    return (
      this.status === BillingKeyStatus.REVOKED &&
      this.pgDeletedAt === null &&
      this.pgDeleteAttemptCount < BILLING_KEY_PG_DELETE_MAX_ATTEMPTS
    );
  }

  /** 토스 삭제 확인. @returns 이번에 기록했으면 true, 이미 기록됐으면 false (멱등) */
  markPgDeleted(now: Date): boolean {
    this.assertRevoked('토스 삭제 기록');
    if (this.pgDeletedAt) return false;
    this.pgDeletedAt = now;
    return true;
  }

  /** 토스 삭제 실패(거절·결과 불명) — 시도 횟수를 올려 한도에 가까워진다 */
  recordPgDeleteFailure(): void {
    this.assertRevoked('토스 삭제 실패 기록');
    this.pgDeleteAttemptCount += 1;
  }

  private assertRevoked(action: string): void {
    if (this.status !== BillingKeyStatus.REVOKED) {
      throw new Error(`빌링키 ${this.billingKeyId}: ${this.status} 상태에서는 ${action} 불가`);
    }
  }

  /** 자동결제에 쓸 수 있는지: 활성이고, 주문의 사용자와 같은 사용자의 수단 */
  usableBy(externalUserId: string): boolean {
    return this.status === BillingKeyStatus.ACTIVE && this.externalUserId === externalUserId;
  }
}
