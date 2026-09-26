import { randomUUID } from 'crypto';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { Order } from '../../order/domain/order.entity';
import type { PaymentCancel } from '../../payment/domain/payment-cancel.entity';
import type { Payment } from '../../payment/domain/payment.entity';
import { OutboxAggregateType, OutboxEventType } from '../constants/outbox.constants';

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

  /**
   * 결제 이벤트. 웹훅 본문의 data가 된다 (docs/api.md 4장).
   * 서비스가 자기 주문을 찾을 수 있게 외부 ID를 넣고, PG 응답 원본·원장 같은 내부 정보는 넣지 않는다.
   */
  static forPayment(eventType: OutboxEventType, payment: Payment, order: Order, occurredAt: Date): OutboxEvent {
    const event = new OutboxEvent();
    event.outboxEventId = randomUUID();
    event.serviceId = payment.serviceId;
    event.eventType = eventType;
    event.aggregateType = OutboxAggregateType.PAYMENT;
    event.aggregateId = payment.paymentId;
    event.payload = {
      paymentId: payment.paymentId,
      orderId: payment.orderId,
      externalOrderId: order.externalOrderId,
      externalUserId: order.externalUserId,
      status: payment.status,
      amount: payment.amount,
      refundedAmount: payment.refundedAmount,
      currency: payment.currency,
      methodType: payment.methodType,
      failureCode: payment.failureCode,
      failureMessage: payment.failureMessage,
    };
    event.occurredAt = occurredAt;
    return event;
  }

  /** 주문 단위 이벤트 (ORDER_EXPIRED). 결제가 없으므로 주문의 외부 ID·금액만 */
  static forOrder(eventType: OutboxEventType, order: Order, occurredAt: Date): OutboxEvent {
    const event = new OutboxEvent();
    event.outboxEventId = randomUUID();
    event.serviceId = order.serviceId;
    event.eventType = eventType;
    event.aggregateType = OutboxAggregateType.ORDER;
    event.aggregateId = order.orderId;
    event.payload = {
      orderId: order.orderId,
      externalOrderId: order.externalOrderId,
      externalUserId: order.externalUserId,
      status: order.status,
      totalAmount: order.totalAmount,
      currency: order.currency,
      expiresAt: order.expiresAt.toISOString(),
    };
    event.occurredAt = occurredAt;
    return event;
  }

  /**
   * 환불 확정 이벤트. 결제 요약(환불 누적 반영) + 이번 취소 건.
   * occurredAt은 다른 이벤트처럼 발행 시각 (이벤트 재조회 순서 = 발행 순서), 토스 취소 시각은 cancel.canceledAt
   */
  static forPaymentCancel(payment: Payment, order: Order, cancel: PaymentCancel, occurredAt: Date): OutboxEvent {
    const canceledAt = cancel.canceledAt ?? occurredAt;
    const event = OutboxEvent.forPayment(OutboxEventType.PAYMENT_CANCELED, payment, order, occurredAt);
    event.payload = {
      ...event.payload,
      cancel: {
        paymentCancelId: cancel.paymentCancelId,
        amount: cancel.amount,
        reasonCode: cancel.reasonCode,
        canceledAt: canceledAt.toISOString(),
      },
    };
    return event;
  }
}
