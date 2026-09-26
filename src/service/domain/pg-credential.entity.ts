import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
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
}
