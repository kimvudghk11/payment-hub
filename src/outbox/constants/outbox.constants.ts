/** DB: ck_tb_outbox_event_type. 결제 "사실"만 담는 범용 이벤트 (서비스별 이벤트 금지) */
export const OutboxEventType = {
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_WAITING_FOR_DEPOSIT: 'PAYMENT_WAITING_FOR_DEPOSIT',
  PAYMENT_CANCELED: 'PAYMENT_CANCELED',
  ORDER_EXPIRED: 'ORDER_EXPIRED',
} as const;
export type OutboxEventType = (typeof OutboxEventType)[keyof typeof OutboxEventType];

/** DB: ck_tb_webhook_delivery_status. PENDING → PROCESSING → SUCCEEDED | RETRYING → … → DEAD */
export const WebhookDeliveryStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  RETRYING: 'RETRYING',
  DEAD: 'DEAD',
} as const;
export type WebhookDeliveryStatus = (typeof WebhookDeliveryStatus)[keyof typeof WebhookDeliveryStatus];

/** tb_outbox_event.aggregate_type */
export const OutboxAggregateType = {
  ORDER: 'ORDER',
  PAYMENT: 'PAYMENT',
  PAYMENT_CANCEL: 'PAYMENT_CANCEL',
} as const;

/** 이 횟수까지 실패하면 DEAD (관리자 재전송 대상). 백오프 1·2·4·…분, 최대 1시간 → 약 4시간 동안 재시도 */
export const WEBHOOK_MAX_ATTEMPTS = 10;
export const WEBHOOK_RETRY_BASE_DELAY_MS = 60_000;
export const WEBHOOK_RETRY_MAX_DELAY_MS = 60 * 60_000;
export const WEBHOOK_LAST_ERROR_MAX_LENGTH = 1000;
