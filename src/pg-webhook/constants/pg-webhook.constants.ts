/** DB: ck_tb_pg_webhook_event_status */
export const PgWebhookEventStatus = {
  RECEIVED: 'RECEIVED',
  PROCESSED: 'PROCESSED',
  IGNORED: 'IGNORED',
  FAILED: 'FAILED',
} as const;
export type PgWebhookEventStatus = (typeof PgWebhookEventStatus)[keyof typeof PgWebhookEventStatus];
