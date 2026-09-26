/** DB: ck_tb_billing_key_status */
export const BillingKeyStatus = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
} as const;
export type BillingKeyStatus = (typeof BillingKeyStatus)[keyof typeof BillingKeyStatus];
