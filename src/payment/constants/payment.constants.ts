/** DB: ck_tb_payment_type. BILLING이면 billing_key_id 필수 */
export const PaymentType = {
  NORMAL: 'NORMAL',
  BILLING: 'BILLING',
} as const;
export type PaymentType = (typeof PaymentType)[keyof typeof PaymentType];

/**
 * DB: ck_tb_payment_status
 * IN_PROGRESS → DONE | FAILED | ABORTED | UNKNOWN | WAITING_FOR_DEPOSIT
 * UNKNOWN → (대사) → DONE | FAILED, WAITING_FOR_DEPOSIT → DONE | EXPIRED
 * DONE → PARTIAL_CANCELED → CANCELED
 */
export const PaymentStatus = {
  IN_PROGRESS: 'IN_PROGRESS',
  UNKNOWN: 'UNKNOWN',
  WAITING_FOR_DEPOSIT: 'WAITING_FOR_DEPOSIT',
  DONE: 'DONE',
  PARTIAL_CANCELED: 'PARTIAL_CANCELED',
  CANCELED: 'CANCELED',
  FAILED: 'FAILED',
  ABORTED: 'ABORTED',
  EXPIRED: 'EXPIRED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** DB: ck_tb_payment_method_type. 토스 응답 method를 hub가 정규화한 결제 수단 분류 */
export const PaymentMethodType = {
  CARD: 'CARD',
  VIRTUAL_ACCOUNT: 'VIRTUAL_ACCOUNT',
  TRANSFER: 'TRANSFER',
  EASY_PAY: 'EASY_PAY',
  MOBILE_PHONE: 'MOBILE_PHONE',
  GIFT_CERTIFICATE: 'GIFT_CERTIFICATE',
} as const;
export type PaymentMethodType = (typeof PaymentMethodType)[keyof typeof PaymentMethodType];

/** DB: ck_tb_payment_card_type. 토스 card.cardType('신용'/'체크'/'기프트'/'미확인') 정규화 */
export const CardType = {
  CREDIT: 'CREDIT',
  CHECK: 'CHECK',
  GIFT: 'GIFT',
  UNKNOWN: 'UNKNOWN',
} as const;
export type CardType = (typeof CardType)[keyof typeof CardType];

/** DB: ck_tb_payment_cancel_status. REQUESTED → DONE | FAILED | UNKNOWN */
export const PaymentCancelStatus = {
  REQUESTED: 'REQUESTED',
  UNKNOWN: 'UNKNOWN',
  DONE: 'DONE',
  FAILED: 'FAILED',
} as const;
export type PaymentCancelStatus = (typeof PaymentCancelStatus)[keyof typeof PaymentCancelStatus];

/** DB: ck_tb_payment_cancel_requested_by */
export const CancelRequestedBy = {
  SERVICE: 'SERVICE',
  ADMIN: 'ADMIN',
  SYSTEM: 'SYSTEM',
} as const;
export type CancelRequestedBy = (typeof CancelRequestedBy)[keyof typeof CancelRequestedBy];
