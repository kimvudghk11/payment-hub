import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { PgProvider } from '../../pg/constants/pg.constants';
import { PgWebhookEventStatus } from '../constants/pg-webhook.constants';

/**
 * 토스 → hub 웹훅 수신 로그 (가상계좌 입금 등). (provider, dedup_key)로 중복 수신을 무시한다.
 * 페이로드를 그대로 신뢰하지 않고 토스 조회 API로 재확인 후 반영한다.
 */
@Entity({ name: 'tb_pg_webhook_event' })
export class PgWebhookEvent {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  pgWebhookEventId: string;

  @Column({ name: 'provider', type: 'varchar', length: 20 })
  provider: PgProvider;

  @Column({ name: 'event_type', type: 'varchar', length: 50 })
  eventType: string;

  /** 중복 수신 방지 키 (paymentKey + 상태 + 시각 등) */
  @Column({ name: 'dedup_key', type: 'varchar', length: 200 })
  dedupKey: string;

  @Column({ name: 'payload', type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status: PgWebhookEventStatus;

  @Column({ name: 'error', type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
