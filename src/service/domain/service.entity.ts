import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import { ServiceStatus } from '../constants/service.constants';

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
}
