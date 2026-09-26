/**
 * DB: ck_tb_order_status
 * PENDING → PAID → PARTIAL_CANCELED → CANCELED, PENDING → EXPIRED
 */
export const OrderStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  PARTIAL_CANCELED: 'PARTIAL_CANCELED',
  CANCELED: 'CANCELED',
  EXPIRED: 'EXPIRED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];
