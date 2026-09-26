/** DB: ck_tb_pg_credential_provider, ck_tb_billing_key_provider, ck_tb_payment_provider */
export const PgProvider = {
  TOSS: 'TOSS',
} as const;
export type PgProvider = (typeof PgProvider)[keyof typeof PgProvider];
