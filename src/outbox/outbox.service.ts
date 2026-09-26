import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../order/domain/order.entity';
import { Payment } from '../payment/domain/payment.entity';
import { Service } from '../service/domain/service.entity';
import { OutboxEventType } from './constants/outbox.constants';
import { OutboxEvent } from './domain/outbox-event.entity';
import { WebhookDelivery } from './domain/webhook-delivery.entity';

/**
 * Transactional Outbox 발행. 결제·취소 상태 변경과 같은 트랜잭션 안에서 호출한다.
 * 실제 전송은 폴러가 tb_webhook_delivery를 읽어 따로 한다 (결제 응답이 웹훅 전송을 기다리지 않음).
 */
@Injectable()
export class OutboxService {
  constructor(
    @InjectRepository(OutboxEvent) private readonly events: Repository<OutboxEvent>,
    @InjectRepository(WebhookDelivery) private readonly deliveries: Repository<WebhookDelivery>,
    @InjectRepository(Service) private readonly services: Repository<Service>,
  ) {}

  /**
   * 이벤트는 항상 남긴다 (서비스가 GET /events로 따라잡을 수 있게).
   * 전달 대상은 서비스에 webhookUrl이 있을 때만 만들고, URL은 지금 값으로 스냅샷한다.
   */
  async publishPaymentEvent(eventType: OutboxEventType, payment: Payment, order: Order): Promise<OutboxEvent> {
    const event = OutboxEvent.forPayment(eventType, payment, order, new Date());
    await this.events.save(event);

    const { webhookUrl } = await this.services.findOneByOrFail({ serviceId: payment.serviceId });
    if (webhookUrl) await this.deliveries.insert(WebhookDelivery.pending(event, webhookUrl));
    return event;
  }
}
