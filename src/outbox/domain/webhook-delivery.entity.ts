import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import {
  WEBHOOK_LAST_ERROR_MAX_LENGTH,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_BASE_DELAY_MS,
  WEBHOOK_RETRY_MAX_DELAY_MS,
  WebhookDeliveryStatus,
} from '../constants/outbox.constants';
import type { OutboxEvent } from './outbox-event.entity';

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

  /** 이벤트 발행 시 전달 대상 생성. URL은 발행 시점 값으로 고정해 이후 URL 변경이 과거 이벤트에 영향을 주지 않게 한다 */
  static pending(event: OutboxEvent, targetUrl: string): WebhookDelivery {
    const delivery = new WebhookDelivery();
    delivery.outboxEventId = event.outboxEventId;
    delivery.serviceId = event.serviceId;
    delivery.targetUrl = targetUrl;
    delivery.status = WebhookDeliveryStatus.PENDING;
    delivery.attemptCount = 0;
    delivery.nextAttemptAt = event.occurredAt;
    delivery.lockedUntil = null;
    delivery.lastHttpStatus = null;
    delivery.lastError = null;
    delivery.deliveredAt = null;
    return delivery;
  }

  /**
   * 워커가 전달할 건을 획득. 임대(lease) 동안은 다른 워커가 가져가지 못하고, 워커가 죽으면 임대 만료 후 재획득된다.
   * next_attempt_at도 임대 만료 시각으로 옮겨, 획득 조건을 "status IN (...) AND next_attempt_at <= now" 하나로 만든다
   * (ix_tb_webhook_delivery_due 인덱스 그대로 사용).
   */
  claim(now: Date, leaseMs: number): void {
    const leaseExpired =
      this.status === WebhookDeliveryStatus.PROCESSING && this.lockedUntil !== null && this.lockedUntil <= now;
    const due = this.status === WebhookDeliveryStatus.PENDING || this.status === WebhookDeliveryStatus.RETRYING;
    if (!due && !leaseExpired) {
      throw new Error(`웹훅 전달 ${this.webhookDeliveryId}: ${this.status} 상태는 획득 불가`);
    }
    const leaseUntil = new Date(now.getTime() + leaseMs);
    this.status = WebhookDeliveryStatus.PROCESSING;
    this.attemptCount += 1;
    this.lockedUntil = leaseUntil;
    this.nextAttemptAt = leaseUntil;
  }

  markSucceeded(httpStatus: number, now: Date): void {
    this.assertProcessing();
    this.status = WebhookDeliveryStatus.SUCCEEDED;
    this.lastHttpStatus = httpStatus;
    this.lastError = null;
    this.deliveredAt = now;
    this.lockedUntil = null;
  }

  /** 2xx가 아니거나 연결 실패. 한도 전이면 지수 백오프로 RETRYING, 한도에 닿으면 DEAD */
  markFailed(failure: { httpStatus: number | null; error: string }, now: Date): void {
    this.assertProcessing();
    this.lastHttpStatus = failure.httpStatus;
    this.lastError = failure.error.slice(0, WEBHOOK_LAST_ERROR_MAX_LENGTH);
    this.lockedUntil = null;
    if (this.attemptCount >= WEBHOOK_MAX_ATTEMPTS) {
      this.status = WebhookDeliveryStatus.DEAD;
      return;
    }
    this.status = WebhookDeliveryStatus.RETRYING;
    this.nextAttemptAt = new Date(now.getTime() + retryDelayMs(this.attemptCount));
  }

  private assertProcessing(): void {
    if (this.status !== WebhookDeliveryStatus.PROCESSING) {
      throw new Error(`웹훅 전달 ${this.webhookDeliveryId}: ${this.status} 상태는 결과 기록 불가`);
    }
  }
}

/** n번째 시도 실패 후 대기: 1분 × 2^(n−1), 최대 1시간 */
const retryDelayMs = (attempt: number): number =>
  Math.min(WEBHOOK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), WEBHOOK_RETRY_MAX_DELAY_MS);
