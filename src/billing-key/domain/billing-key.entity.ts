import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import { PgProvider } from '../../pg/constants/pg.constants';
import { BillingKeyStatus } from '../constants/billing-key.constants';

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
}
