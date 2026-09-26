import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { EncryptionService } from '../common/crypto/encryption.service';
import { Service } from '../service/domain/service.entity';
import { WebhookDeliveryStatus } from './constants/outbox.constants';
import { OutboxEvent } from './domain/outbox-event.entity';
import { WebhookDelivery } from './domain/webhook-delivery.entity';
import { WebhookSendResult, WebhookSender } from './webhook-sender';

/** 한 번에 획득하는 전달 건 수 */
export const WEBHOOK_DISPATCH_BATCH_SIZE = 20;
/** 전송 타임아웃보다 넉넉하게. 이 시간 안에 결과를 기록하지 못하면 다른 워커가 다시 가져간다 */
const LEASE_MARGIN_MS = 30_000;

const CLAIMABLE_STATUSES = [
  WebhookDeliveryStatus.PENDING,
  WebhookDeliveryStatus.RETRYING,
  WebhookDeliveryStatus.PROCESSING,
];

export interface DispatchResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

/**
 * outbox 웹훅 발송. (tx) FOR UPDATE SKIP LOCKED로 due 건 획득·임대 → 전송(트랜잭션 밖) → (tx) 결과 기록.
 * 여러 인스턴스가 동시에 돌아도 한 건은 한 워커만 가져간다. 서명 키는 전송 시점의 현재 키를 쓴다.
 */
@Injectable()
export class WebhookDispatcher {
  constructor(
    @InjectRepository(WebhookDelivery) private readonly deliveries: Repository<WebhookDelivery>,
    @InjectRepository(OutboxEvent) private readonly events: Repository<OutboxEvent>,
    @InjectRepository(Service) private readonly services: Repository<Service>,
    private readonly encryption: EncryptionService,
    private readonly sender: WebhookSender,
  ) {}

  async dispatchDue(now: Date = new Date(), limit: number = WEBHOOK_DISPATCH_BATCH_SIZE): Promise<DispatchResult> {
    const claimed = await this.claimDue(now, limit);
    const outcomes = await Promise.all(claimed.map((delivery) => this.deliver(delivery, now)));
    const succeeded = outcomes.filter(Boolean).length;
    return { claimed: claimed.length, succeeded, failed: claimed.length - succeeded };
  }

  @Transactional()
  private async claimDue(now: Date, limit: number): Promise<WebhookDelivery[]> {
    const due = await this.deliveries
      .createQueryBuilder('d')
      .where({ status: In(CLAIMABLE_STATUSES), nextAttemptAt: LessThanOrEqual(now) })
      .orderBy('d.nextAttemptAt', 'ASC')
      .limit(limit)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();
    for (const delivery of due) {
      delivery.claim(now, this.sender.timeoutMs + LEASE_MARGIN_MS);
      await this.deliveries.save(delivery);
    }
    return due;
  }

  private async deliver(delivery: WebhookDelivery, now: Date): Promise<boolean> {
    const message = await this.buildMessage(delivery);
    const result: WebhookSendResult =
      'error' in message
        ? { ok: false, httpStatus: null, error: message.error }
        : await this.sender.send({ url: delivery.targetUrl, eventId: delivery.outboxEventId, ...message });
    await this.record(delivery.webhookDeliveryId, delivery.attemptCount, result, now);
    return result.ok;
  }

  /** 웹훅 본문 (docs/api.md 4장). 서명은 이 원문 문자열 그대로에 한다 */
  private async buildMessage(
    delivery: WebhookDelivery,
  ): Promise<{ rawBody: string; secret: string } | { error: string }> {
    const service = await this.services.findOneBy({ serviceId: delivery.serviceId });
    if (!service?.webhookSecretEnc || !service.webhookSecretKeyId) {
      return { error: '웹훅 서명 키가 없습니다. admin이 서명 키를 발급해야 합니다.' };
    }
    const event = await this.events.findOneByOrFail({ outboxEventId: delivery.outboxEventId });
    return {
      secret: this.encryption.decrypt(service.webhookSecretEnc, service.webhookSecretKeyId),
      rawBody: JSON.stringify({
        eventId: event.outboxEventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt.toISOString(),
        data: event.payload,
      }),
    };
  }

  /** 임대가 만료돼 다른 워커가 다시 가져간 건(시도 횟수가 달라짐)은 덮어쓰지 않는다 */
  @Transactional()
  private async record(deliveryId: string, attempt: number, result: WebhookSendResult, now: Date): Promise<void> {
    const delivery = await this.deliveries.findOneOrFail({
      where: { webhookDeliveryId: deliveryId },
      lock: { mode: 'pessimistic_write' },
    });
    if (delivery.status !== WebhookDeliveryStatus.PROCESSING || delivery.attemptCount !== attempt) return;
    if (result.ok) delivery.markSucceeded(result.httpStatus, now);
    else delivery.markFailed(result, now);
    await this.deliveries.save(delivery);
  }
}
