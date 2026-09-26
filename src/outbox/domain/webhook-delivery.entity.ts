import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import { WebhookDeliveryStatus } from '../constants/outbox.constants';

/** hub → 서비스 웹훅 전달 상태(가변). 폴러가 FOR UPDATE SKIP LOCKED로 due 건을 획득한다. */
@Entity({ name: 'tb_webhook_delivery' })
export class WebhookDelivery extends BaseEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  webhookDeliveryId: string;

  @Column({ name: 'event_id', type: 'uuid' })
  outboxEventId: string;

  @Column({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  /** 발행 시점 URL 스냅샷 */
  @Column({ name: 'target_url', type: 'text' })
  targetUrl: string;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status: WebhookDeliveryStatus;

  @Column({ name: 'attempt_count', type: 'integer' })
  attemptCount: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt: Date;

  /** 처리 중 인스턴스가 죽으면 이 시각 이후 재획득 */
  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @Column({ name: 'last_http_status', type: 'integer', nullable: true })
  lastHttpStatus: number | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;
}
