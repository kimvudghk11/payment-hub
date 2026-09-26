/** DB: ck_tb_service_status. SUSPENDED면 키가 유효해도 서비스 API 전부 거부 */
export const ServiceStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;
export type ServiceStatus = (typeof ServiceStatus)[keyof typeof ServiceStatus];

/** DB: ck_tb_pg_credential_env */
export const PgEnvironment = {
  TEST: 'TEST',
  LIVE: 'LIVE',
} as const;
export type PgEnvironment = (typeof PgEnvironment)[keyof typeof PgEnvironment];
