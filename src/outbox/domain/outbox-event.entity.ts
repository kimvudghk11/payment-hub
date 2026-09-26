import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { OutboxEventType } from '../constants/outbox.constants';

/**
 * 결제 "사실"만 담는 불변 이벤트 (Transactional Outbox).
 * 결제/취소 상태 변경과 같은 DB 트랜잭션에서 INSERT한다. 전달 상태는 WebhookDelivery가 가진다.
 */
@Entity({ name: 'tb_outbox_event' })
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  outboxEventId: string;

  @Column({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 50 })
  eventType: OutboxEventType;

  /** ORDER / PAYMENT / PAYMENT_CANCEL */
  @Column({ name: 'aggregate_type', type: 'varchar', length: 30 })
  aggregateType: string;

  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId: string;

  @Column({ name: 'payload', type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;
}
