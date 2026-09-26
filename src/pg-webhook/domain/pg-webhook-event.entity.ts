import { createHash } from 'crypto';
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

  /**
   * 수신 기록. 같은 사건(유형·대상 결제·상태·토스 발생 시각)이 다시 오면 dedup_key 유니크로 걸러진다.
   * 키가 컬럼 한도를 넘으면 해시로 줄인다.
   */
  static receive(
    key: { eventType: string; reference: string; status: string; createdAt: string },
    payload: Record<string, unknown>,
    now: Date,
  ): PgWebhookEvent {
    const raw = `${key.eventType}:${key.reference}:${key.status}:${key.createdAt}`;
    const event = new PgWebhookEvent();
    event.provider = PgProvider.TOSS;
    event.eventType = key.eventType.slice(0, 50);
    event.dedupKey = raw.length <= 200 ? raw : `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    event.payload = payload;
    event.status = PgWebhookEventStatus.RECEIVED;
    event.error = null;
    event.receivedAt = now;
    event.processedAt = null;
    return event;
  }

  /** 토스 조회로 재확인하고 반영(또는 이미 같은 상태)까지 끝남 */
  markProcessed(now: Date): void {
    this.finish(PgWebhookEventStatus.PROCESSED, null, now);
  }

  /** hub가 처리할 대상이 아님 (모르는 결제, 이미 확정된 결제, 관심 없는 이벤트) */
  markIgnored(reason: string, now: Date): void {
    this.finish(PgWebhookEventStatus.IGNORED, reason, now);
  }

  /** 재확인 실패 — 결제는 대사 배치가 이어받는다 */
  markFailed(error: string, now: Date): void {
    this.finish(PgWebhookEventStatus.FAILED, error, now);
  }

  private finish(status: PgWebhookEventStatus, error: string | null, now: Date): void {
    this.status = status;
    this.error = error;
    this.processedAt = now;
  }
}
