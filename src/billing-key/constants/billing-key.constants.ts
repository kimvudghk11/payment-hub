/** DB: ck_tb_billing_key_status */
export const BillingKeyStatus = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
} as const;
export type BillingKeyStatus = (typeof BillingKeyStatus)[keyof typeof BillingKeyStatus];

/** 토스 쪽 빌링키 삭제 시도 한도. 넘기면 재시도 배치가 더 이상 잡지 않는다 (로그로 남김) */
export const BILLING_KEY_PG_DELETE_MAX_ATTEMPTS = 10;
