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
