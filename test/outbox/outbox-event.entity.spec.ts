import {
  OutboxEventType,
  WEBHOOK_MAX_ATTEMPTS,
  WebhookDeliveryStatus,
} from '../../src/outbox/constants/outbox.constants';
import { OutboxEvent } from '../../src/outbox/domain/outbox-event.entity';
import { WebhookDelivery } from '../../src/outbox/domain/webhook-delivery.entity';
import { Order } from '../../src/order/domain/order.entity';
import { PaymentMethodType, PaymentStatus } from '../../src/payment/constants/payment.constants';
import { PaymentCancel } from '../../src/payment/domain/payment-cancel.entity';
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

describe('WebhookDelivery — 전달 시도 상태', () => {
  const LEASE_MS = 60_000;
  const t0 = new Date('2026-09-27T02:00:00.000Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const pending = () =>
    WebhookDelivery.pending(
      OutboxEvent.forPayment(OutboxEventType.PAYMENT_CONFIRMED, payment, order, now),
      'https://a',
    );

  describe('claim — 워커가 전달할 건을 획득', () => {
    it('PENDING → PROCESSING, 시도 횟수 +1, 임대 만료 시각까지 다른 워커가 못 가져간다', () => {
      const delivery = pending();
      delivery.claim(t0, LEASE_MS);

      expect(delivery).toMatchObject({
        status: WebhookDeliveryStatus.PROCESSING,
        attemptCount: 1,
        lockedUntil: at(LEASE_MS),
        // 획득 조건(next_attempt_at <= now)을 인덱스 하나로 처리하려고 임대 만료 시각을 함께 둔다
        nextAttemptAt: at(LEASE_MS),
      });
    });

    it('처리 중 워커가 죽어 임대가 만료된 건은 다시 획득할 수 있다', () => {
      const delivery = pending();
      delivery.claim(t0, LEASE_MS);
      delivery.claim(at(LEASE_MS), LEASE_MS);
      expect(delivery.attemptCount).toBe(2);
    });

    it('임대가 남은 건, 끝난 건(SUCCEEDED·DEAD)은 획득할 수 없다', () => {
      const processing = pending();
      processing.claim(t0, LEASE_MS);
      expect(() => processing.claim(at(1000), LEASE_MS)).toThrow('PROCESSING');

      const succeeded = pending();
      succeeded.claim(t0, LEASE_MS);
      succeeded.markSucceeded(200, at(10));
      expect(() => succeeded.claim(at(LEASE_MS * 10), LEASE_MS)).toThrow('SUCCEEDED');
    });
  });

  describe('결과 기록', () => {
    it('2xx → SUCCEEDED, 전달 시각·응답 코드 기록, 임대 해제', () => {
      const delivery = pending();
      delivery.claim(t0, LEASE_MS);
      delivery.markSucceeded(204, at(300));

      expect(delivery).toMatchObject({
        status: WebhookDeliveryStatus.SUCCEEDED,
        deliveredAt: at(300),
        lastHttpStatus: 204,
        lastError: null,
        lockedUntil: null,
      });
    });

    it('실패 → RETRYING, 다음 시도는 지수 백오프 (1분, 2분, 4분 … 최대 1시간)', () => {
      const delivery = pending();
      const delays: number[] = [];
      let clock = t0;
      for (let attempt = 1; attempt <= 8; attempt++) {
        delivery.claim(clock, LEASE_MS);
        delivery.markFailed({ httpStatus: 500, error: 'HTTP 500' }, clock);
        delays.push((delivery.nextAttemptAt.getTime() - clock.getTime()) / 60_000);
        clock = delivery.nextAttemptAt;
      }

      expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
      expect(delivery).toMatchObject({
        status: WebhookDeliveryStatus.RETRYING,
        lastHttpStatus: 500,
        lastError: 'HTTP 500',
        lockedUntil: null,
      });
    });

    it(`${WEBHOOK_MAX_ATTEMPTS}번째 시도까지 실패하면 DEAD — 관리자 재전송 대상`, () => {
      const delivery = pending();
      let clock = t0;
      for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
        delivery.claim(clock, LEASE_MS);
        delivery.markFailed({ httpStatus: null, error: 'ECONNREFUSED' }, clock);
        clock = delivery.nextAttemptAt;
      }

      expect(delivery.status).toBe(WebhookDeliveryStatus.DEAD);
      expect(delivery.attemptCount).toBe(WEBHOOK_MAX_ATTEMPTS);
    });

    it('에러 메시지는 1000자로 자른다 (응답 본문 전체를 저장하지 않음)', () => {
      const delivery = pending();
      delivery.claim(t0, LEASE_MS);
      delivery.markFailed({ httpStatus: 400, error: 'x'.repeat(5000) }, t0);
      expect(delivery.lastError).toHaveLength(1000);
    });

    it('PROCESSING이 아니면 결과를 기록할 수 없다', () => {
      expect(() => pending().markSucceeded(200, t0)).toThrow('PENDING');
    });
  });
});

describe('OutboxEvent.forPaymentCancel', () => {
  it('PAYMENT_CANCELED: 결제 요약(환불 누적 반영) + 이번 취소 건 정보', () => {
    const canceledPayment = Object.assign(new Payment(), {
      ...payment,
      status: PaymentStatus.PARTIAL_CANCELED,
      refundedAmount: 3000,
    });
    const cancel = Object.assign(new PaymentCancel(), {
      paymentCancelId: 'cancel-1',
      amount: 3000,
      reasonCode: 'USER_REQUEST',
      canceledAt: now,
    });

    const event = OutboxEvent.forPaymentCancel(canceledPayment, order, cancel);

    expect(event).toMatchObject({ eventType: OutboxEventType.PAYMENT_CANCELED, aggregateId: 'pay-1', occurredAt: now });
    expect(event.payload).toMatchObject({
      paymentId: 'pay-1',
      status: PaymentStatus.PARTIAL_CANCELED,
      refundedAmount: 3000,
      cancel: { paymentCancelId: 'cancel-1', amount: 3000, reasonCode: 'USER_REQUEST', canceledAt: now.toISOString() },
    });
  });
});

describe('WebhookDelivery.redeliver — 관리자 재전송', () => {
  const t0 = new Date('2026-09-27T02:00:00.000Z');
  const dead = () => {
    const delivery = WebhookDelivery.pending(
      OutboxEvent.forPayment(OutboxEventType.PAYMENT_CONFIRMED, payment, order, now),
      'https://old.example.com/hook',
    );
    let clock = t0;
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      delivery.claim(clock, 60_000);
      delivery.markFailed({ httpStatus: 404, error: 'HTTP 404' }, clock);
      clock = delivery.nextAttemptAt;
    }
    return delivery;
  };

  it('DEAD → PENDING, 바로 보낼 수 있게, 서비스의 현재 webhookUrl로 (시도 횟수는 유지)', () => {
    const delivery = dead();
    const redeliverAt = new Date('2026-09-28T00:00:00.000Z');

    expect(delivery.redeliver(redeliverAt, 'https://new.example.com/hook')).toBe(true);
    expect(delivery).toMatchObject({
      status: WebhookDeliveryStatus.PENDING,
      nextAttemptAt: redeliverAt,
      targetUrl: 'https://new.example.com/hook',
      attemptCount: WEBHOOK_MAX_ATTEMPTS,
    });
  });

  it('재전송한 건이 또 실패하면 다시 DEAD (한 번 더 보내 보는 것)', () => {
    const delivery = dead();
    delivery.redeliver(t0, 'https://new.example.com/hook');
    delivery.claim(t0, 60_000);
    delivery.markFailed({ httpStatus: 500, error: 'HTTP 500' }, t0);
    expect(delivery.status).toBe(WebhookDeliveryStatus.DEAD);
  });

  it('이미 성공한 건도 재전송할 수 있다 (서비스가 처리 중 데이터를 잃은 경우)', () => {
    const delivery = WebhookDelivery.pending(
      OutboxEvent.forPayment(OutboxEventType.PAYMENT_CONFIRMED, payment, order, now),
      'https://a',
    );
    delivery.claim(t0, 60_000);
    delivery.markSucceeded(200, t0);

    expect(delivery.redeliver(t0, 'https://a')).toBe(true);
    expect(delivery.status).toBe(WebhookDeliveryStatus.PENDING);
  });

  it.each([WebhookDeliveryStatus.PENDING, WebhookDeliveryStatus.PROCESSING])(
    '%s는 이미 보낼 예정·보내는 중이라 바꾸지 않는다 (멱등, false)',
    (status) => {
      const delivery = WebhookDelivery.pending(
        OutboxEvent.forPayment(OutboxEventType.PAYMENT_CONFIRMED, payment, order, now),
        'https://a',
      );
      if (status === WebhookDeliveryStatus.PROCESSING) delivery.claim(t0, 60_000);
      const before = { ...delivery };

      expect(delivery.redeliver(t0, 'https://b')).toBe(false);
      expect({ ...delivery }).toEqual(before);
    },
  );

  it('RETRYING은 기다리지 않고 지금 보내도록 당긴다', () => {
    const delivery = WebhookDelivery.pending(
      OutboxEvent.forPayment(OutboxEventType.PAYMENT_CONFIRMED, payment, order, now),
      'https://a',
    );
    delivery.claim(t0, 60_000);
    delivery.markFailed({ httpStatus: 500, error: 'HTTP 500' }, t0);

    expect(delivery.redeliver(t0, 'https://a')).toBe(true);
    expect(delivery).toMatchObject({ status: WebhookDeliveryStatus.PENDING, nextAttemptAt: t0 });
  });
});
