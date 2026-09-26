import { OutboxEventType, WebhookDeliveryStatus } from '../../src/outbox/constants/outbox.constants';
import { OutboxEvent } from '../../src/outbox/domain/outbox-event.entity';
import { WebhookDelivery } from '../../src/outbox/domain/webhook-delivery.entity';
import { Order } from '../../src/order/domain/order.entity';
import { PaymentMethodType, PaymentStatus } from '../../src/payment/constants/payment.constants';
import { Payment } from '../../src/payment/domain/payment.entity';

const now = new Date('2026-09-27T01:16:04.000Z');
const order = Object.assign(new Order(), {
  orderId: 'order-1',
  externalOrderId: 'svc-order-0001',
  externalUserId: 'user-123',
});
const payment = Object.assign(new Payment(), {
  paymentId: 'pay-1',
  orderId: 'order-1',
  serviceId: 'svc-1',
  status: PaymentStatus.DONE,
  amount: 30000,
  refundedAmount: 0,
  currency: 'KRW',
  methodType: PaymentMethodType.CARD,
  failureCode: null,
  failureMessage: null,
  providerResponse: { secret: 'PG 원문은 이벤트에 넣지 않는다' },
});

describe('OutboxEvent.forPayment', () => {
  it('결제 사실만 담는 범용 이벤트 — 서비스가 자기 주문을 찾을 수 있게 외부 ID를 포함한다', () => {
    const event = OutboxEvent.forPayment(OutboxEventType.PAYMENT_CONFIRMED, payment, order, now);

    expect(event).toMatchObject({
      serviceId: 'svc-1',
      eventType: OutboxEventType.PAYMENT_CONFIRMED,
      aggregateType: 'PAYMENT',
      aggregateId: 'pay-1',
      occurredAt: now,
    });
    expect(event.outboxEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.payload).toEqual({
      paymentId: 'pay-1',
      orderId: 'order-1',
      externalOrderId: 'svc-order-0001',
      externalUserId: 'user-123',
      status: PaymentStatus.DONE,
      amount: 30000,
      refundedAmount: 0,
      currency: 'KRW',
      methodType: PaymentMethodType.CARD,
      failureCode: null,
      failureMessage: null,
    });
  });
});

describe('WebhookDelivery.pending', () => {
  it('발행 시점 webhookUrl을 스냅샷하고 바로 전달 대상이 된다', () => {
    const event = OutboxEvent.forPayment(OutboxEventType.PAYMENT_CONFIRMED, payment, order, now);
    const delivery = WebhookDelivery.pending(event, 'https://svc.example.com/webhooks/payment-hub');

    expect(delivery).toMatchObject({
      outboxEventId: event.outboxEventId,
      serviceId: 'svc-1',
      targetUrl: 'https://svc.example.com/webhooks/payment-hub',
      status: WebhookDeliveryStatus.PENDING,
      attemptCount: 0,
      nextAttemptAt: now,
      lockedUntil: null,
    });
  });
});
