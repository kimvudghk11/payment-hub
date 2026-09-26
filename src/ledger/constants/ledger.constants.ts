/** DB: ck_tb_ledger_account_type */
export const LedgerAccountType = {
  ASSET: 'ASSET',
  LIABILITY: 'LIABILITY',
  REVENUE: 'REVENUE',
  CONTRA_REVENUE: 'CONTRA_REVENUE',
  EXPENSE: 'EXPENSE',
} as const;
export type LedgerAccountType = (typeof LedgerAccountType)[keyof typeof LedgerAccountType];

/** DB: ck_tb_ledger_transaction_type */
export const LedgerTransactionType = {
  PAYMENT_CAPTURED: 'PAYMENT_CAPTURED',
  PAYMENT_CANCELED: 'PAYMENT_CANCELED',
  PG_SETTLED: 'PG_SETTLED',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type LedgerTransactionType = (typeof LedgerTransactionType)[keyof typeof LedgerTransactionType];

/** DB: ck_tb_ledger_entry_direction */
export const LedgerDirection = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
} as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

/**
 * 계정 코드 (DB 제한 없음 — 계정은 데이터). 서비스별 계정은 service_id를 채우고, 회사 공통 계정(CASH)은 NULL.
 * 분개 규칙은 CLAUDE.md 4장 "원장 분개 규칙".
 */
export const LedgerAccountCode = {
  PG_RECEIVABLE: 'PG_RECEIVABLE',
  REVENUE: 'REVENUE',
  REFUND: 'REFUND',
  PG_FEE: 'PG_FEE',
  CASH: 'CASH',
} as const;
export type LedgerAccountCode = (typeof LedgerAccountCode)[keyof typeof LedgerAccountCode];

export const LEDGER_ACCOUNT_TYPES: Record<LedgerAccountCode, LedgerAccountType> = {
  PG_RECEIVABLE: LedgerAccountType.ASSET,
  REVENUE: LedgerAccountType.REVENUE,
  REFUND: LedgerAccountType.CONTRA_REVENUE,
  PG_FEE: LedgerAccountType.EXPENSE,
  CASH: LedgerAccountType.ASSET,
};

/** tb_ledger_transaction.reference_type */
export const LedgerReferenceType = {
  PAYMENT: 'PAYMENT',
  PAYMENT_CANCEL: 'PAYMENT_CANCEL',
  SETTLEMENT: 'SETTLEMENT',
} as const;
