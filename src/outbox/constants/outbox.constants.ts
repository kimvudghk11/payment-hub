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
