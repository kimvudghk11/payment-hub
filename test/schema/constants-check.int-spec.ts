import { Client } from 'pg';
import { AdminAuditAction } from '../../src/admin/audit/constants/admin-audit.constants';
import { BillingKeyStatus } from '../../src/billing-key/constants/billing-key.constants';
import { LedgerAccountType, LedgerDirection, LedgerTransactionType } from '../../src/ledger/constants/ledger.constants';
import { OrderStatus } from '../../src/order/constants/order.constants';
import { OutboxEventType, WebhookDeliveryStatus } from '../../src/outbox/constants/outbox.constants';
import {
  CancelRequestedBy,
  PaymentCancelStatus,
  PaymentStatus,
  PaymentType,
} from '../../src/payment/constants/payment.constants';
import { PgWebhookEventStatus } from '../../src/pg-webhook/constants/pg-webhook.constants';
import { PgProvider } from '../../src/pg/constants/pg.constants';
import { PgEnvironment, ServiceStatus } from '../../src/service/constants/service.constants';
import { testDbConfig } from '../setup/test-db';

/** constants의 상태 값은 DB CHECK 제약 값과 1:1로 일치해야 한다 (CLAUDE.md 9장). */
const CONSTANT_BY_CHECK: Record<string, Record<string, string>> = {
  ck_tb_service_status: ServiceStatus,
  ck_tb_pg_credential_provider: PgProvider,
  ck_tb_pg_credential_env: PgEnvironment,
  ck_tb_billing_key_provider: PgProvider,
  ck_tb_billing_key_status: BillingKeyStatus,
  ck_tb_order_status: OrderStatus,
  ck_tb_payment_provider: PgProvider,
  ck_tb_payment_type: PaymentType,
  ck_tb_payment_status: PaymentStatus,
  ck_tb_payment_cancel_status: PaymentCancelStatus,
  ck_tb_payment_cancel_requested_by: CancelRequestedBy,
  ck_tb_ledger_account_type: LedgerAccountType,
  ck_tb_ledger_transaction_type: LedgerTransactionType,
  ck_tb_ledger_entry_direction: LedgerDirection,
  ck_tb_outbox_event_type: OutboxEventType,
  ck_tb_webhook_delivery_status: WebhookDeliveryStatus,
  ck_tb_pg_webhook_event_status: PgWebhookEventStatus,
  ck_tb_admin_audit_log_action: AdminAuditAction,
};

describe('constants ↔ DB CHECK 제약 값', () => {
  let client: Client;
  let checkDefs: Map<string, string>;

  // CHECK 정의에서 'VALUE'::character varying 형태의 문자열 리터럴만 뽑는다
  const literalsOf = (def: string) => [...def.matchAll(/'([^']+)'::/g)].map((m) => m[1]).sort();

  beforeAll(async () => {
    client = new Client(testDbConfig());
    await client.connect();
    const { rows } = await client.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE contype = 'c' AND connamespace = 'public'::regnamespace`,
    );
    checkDefs = new Map(rows.map((r) => [r.conname, r.def]));
  });

  afterAll(async () => {
    await client?.end();
  });

  it.each(Object.entries(CONSTANT_BY_CHECK))('%s 값이 constants와 일치한다', (conname, constant) => {
    const def = checkDefs.get(conname);

    expect(def).toBeDefined();
    expect(literalsOf(def!)).toEqual(Object.values(constant).sort());
  });

  it('값 목록(IN/ANY)을 가진 CHECK 제약은 모두 constants에 대응된다', () => {
    const uncovered = [...checkDefs.entries()]
      .filter(([, def]) => /ANY \(\(?ARRAY\[/.test(def))
      .map(([name]) => name)
      .filter((name) => !(name in CONSTANT_BY_CHECK));

    expect(uncovered).toEqual([]);
  });
});
