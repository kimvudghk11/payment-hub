-- =====================================================================
-- payment-hub schema (PostgreSQL 15+)
--
-- 원칙
--  1. 금액은 모두 bigint, 통화의 최소 단위(minor unit)로 저장한다.
--     KRW 10,000원 = 10000 / USD $12.34 = 1234
--  2. ledger가 분기(if/switch)하는 값은 varchar + CHECK 제약으로 제한한다.
--     (PostgreSQL enum은 값 추가/삭제 마이그레이션이 까다롭기 때문)
--     서비스가 자유롭게 정의하는 값은 CHECK 없이 varchar로 둔다.
--  3. 서비스 소유권은 복합 FK (x_id, service_id)로 DB 레벨에서 강제한다.
--     → 서비스 A의 주문에 서비스 B의 결제/상품이 붙는 것을 원천 차단
--  4. 원장(ledger_*)은 append-only. UPDATE/DELETE 금지, 차변=대변 강제.
--  5. 비밀값(토스 시크릿 키, 빌링키, 웹훅 서명 키)은 암호화해서 저장하고
--     enc_key_id로 어떤 키로 암호화했는지 기록한다(키 교체 대비).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() (PG13+는 기본 내장)

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =====================================================================
-- 1. 서비스 (연동 플랫폼, 인증, PG 자격증명, 상품 유형)
-- =====================================================================

CREATE TABLE tb_service (
  id                  uuid         NOT NULL DEFAULT gen_random_uuid(),
  code                varchar(20)  NOT NULL,              -- 'SVC_A' 같은 사람이 읽는 식별자
  name                varchar(100) NOT NULL,
  status              varchar(20)  NOT NULL DEFAULT 'ACTIVE',
  webhook_url         text         NULL,                  -- 결제 이벤트를 받을 서비스 엔드포인트
  webhook_secret_enc  bytea        NULL,                  -- 우리가 보내는 웹훅의 HMAC 서명 키 (암호화)
  webhook_secret_key_id varchar(100) NULL,
  deleted_at          timestamptz  NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_service PRIMARY KEY (id),
  CONSTRAINT uq_tb_service_code UNIQUE (code),
  CONSTRAINT ck_tb_service_status CHECK (status IN ('ACTIVE', 'SUSPENDED'))
);
COMMENT ON COLUMN tb_service.status IS 'SUSPENDED: 일시 차단(키 유효해도 요청 거부). 삭제는 deleted_at';

CREATE TABLE tb_service_api_key (
  id            uuid         NOT NULL DEFAULT gen_random_uuid(),
  service_id    uuid         NOT NULL,
  label         varchar(50)  NOT NULL,                    -- 'prod-server-1', 'batch' 등
  key_prefix    varchar(12)  NOT NULL,                    -- 'ph_live_' / 'ph_test_'. 환경 구분 + 로그 식별용
  key_hint      char(4)      NOT NULL,                    -- 마지막 4자리. 어드민 표시용
  key_hash      char(64)     NOT NULL,                    -- SHA-256 hex
  expires_at    timestamptz  NULL,                        -- NULL = 만료 없음
  last_used_at  timestamptz  NULL,
  revoked_at    timestamptz  NULL,                        -- NULL = 유효
  created_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_service_api_key PRIMARY KEY (id),
  CONSTRAINT uq_tb_service_api_key_hash UNIQUE (key_hash),
  CONSTRAINT fk_tb_service_api_key_service FOREIGN KEY (service_id) REFERENCES tb_service (id)
);
CREATE INDEX ix_tb_service_api_key_service ON tb_service_api_key (service_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE tb_service_api_key IS '서비스당 여러 키 허용 → 신규 키 발급 후 구 키 revoke로 무중단 교체';

CREATE TABLE tb_pg_credential (
  id               uuid         NOT NULL DEFAULT gen_random_uuid(),
  service_id       uuid         NOT NULL,
  provider         varchar(20)  NOT NULL DEFAULT 'TOSS',
  environment      varchar(10)  NOT NULL,                 -- TEST / LIVE
  merchant_id      varchar(100) NULL,                     -- 토스 mId
  client_key       varchar(200) NULL,                     -- 공개 키. 서비스 프론트가 결제창 띄울 때 사용
  secret_key_enc   bytea        NOT NULL,                 -- 시크릿 키 (암호화)
  secret_key_id    varchar(100) NOT NULL,                 -- 암호화에 쓴 KMS 키 / 버전
  secret_key_hint  char(4)      NOT NULL,
  is_active        boolean      NOT NULL DEFAULT true,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_pg_credential PRIMARY KEY (id),
  CONSTRAINT fk_tb_pg_credential_service FOREIGN KEY (service_id) REFERENCES tb_service (id),
  CONSTRAINT ck_tb_pg_credential_provider CHECK (provider IN ('TOSS')),
  CONSTRAINT ck_tb_pg_credential_env CHECK (environment IN ('TEST', 'LIVE'))
);
-- 서비스·PG·환경별로 활성 자격증명은 하나만
CREATE UNIQUE INDEX uq_tb_pg_credential_active
  ON tb_pg_credential (service_id, provider, environment) WHERE is_active;

CREATE TABLE tb_service_product_type (
  service_id   uuid         NOT NULL,
  code         varchar(50)  NOT NULL,                     -- 'PLAN', 'CREDIT', 'ADDON' ...
  name         varchar(100) NOT NULL,
  is_active    boolean      NOT NULL DEFAULT true,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_service_product_type PRIMARY KEY (service_id, code),
  CONSTRAINT fk_tb_service_product_type_service FOREIGN KEY (service_id) REFERENCES tb_service (id)
);
COMMENT ON TABLE tb_service_product_type IS
  '상품 카탈로그가 아닌 "이 서비스가 파는 상품 유형" 화이트리스트. 상품 상세 검증은 서비스 책임';


-- =====================================================================
-- 2. 빌링키 (자동결제 수단)
-- =====================================================================

CREATE TABLE tb_billing_key (
  id                  uuid         NOT NULL DEFAULT gen_random_uuid(),
  service_id          uuid         NOT NULL,
  external_user_id    varchar(100) NOT NULL,              -- 서비스의 사용자 ID
  provider            varchar(20)  NOT NULL DEFAULT 'TOSS',
  customer_key        varchar(300) NOT NULL,              -- 토스 customerKey
  billing_key_enc     bytea        NOT NULL,              -- 시크릿 키와 합쳐지면 결제가 가능한 값 → 암호화
  billing_key_key_id  varchar(100) NOT NULL,
  card_company        varchar(50)  NULL,
  card_number_masked  varchar(30)  NULL,                  -- '1234-****-****-5678'
  status              varchar(20)  NOT NULL DEFAULT 'ACTIVE',
  revoked_at          timestamptz  NULL,
  -- 토스 쪽 빌링키 삭제. hub 폐기(REVOKED) 커밋 후 호출하고, 실패하면 재시도 배치가 한도까지 다시 시도한다
  pg_deleted_at            timestamptz NULL,
  pg_delete_attempt_count  integer     NOT NULL DEFAULT 0,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_billing_key PRIMARY KEY (id),
  CONSTRAINT uq_tb_billing_key_id_service UNIQUE (id, service_id),   -- 복합 FK 대상
  CONSTRAINT fk_tb_billing_key_service FOREIGN KEY (service_id) REFERENCES tb_service (id),
  CONSTRAINT ck_tb_billing_key_provider CHECK (provider IN ('TOSS')),
  CONSTRAINT ck_tb_billing_key_status CHECK (status IN ('ACTIVE', 'REVOKED')),
  -- 토스 삭제는 hub에서 폐기한 키만
  CONSTRAINT ck_tb_billing_key_pg_deleted CHECK (pg_deleted_at IS NULL OR status = 'REVOKED'),
  CONSTRAINT ck_tb_billing_key_pg_delete_attempts CHECK (pg_delete_attempt_count >= 0)
);
CREATE INDEX ix_tb_billing_key_user ON tb_billing_key (service_id, external_user_id) WHERE status = 'ACTIVE';
-- 토스 삭제 재시도 배치 대상 (오래 전에 시도한 순)
CREATE INDEX ix_tb_billing_key_pg_delete ON tb_billing_key (updated_at)
  WHERE status = 'REVOKED' AND pg_deleted_at IS NULL;


-- =====================================================================
-- 3. 주문 (서비스 서버가 사전 등록 → 금액 고정)
-- =====================================================================

CREATE TABLE tb_order (
  id                        uuid         NOT NULL DEFAULT gen_random_uuid(), -- 토스 orderId로 사용
  service_id                uuid         NOT NULL,
  external_order_id         varchar(100) NOT NULL,        -- 서비스 쪽 주문번호. (service_id, 이 값) = 주문 생성 멱등키
  external_user_id          varchar(100) NOT NULL,
  external_subscription_id  varchar(100) NULL,
  order_name                varchar(100) NOT NULL,        -- 토스 orderName (최대 100자)
  currency                  char(3)      NOT NULL DEFAULT 'KRW',
  original_amount           bigint       NOT NULL,        -- = sum(order_item.amount)
  discount_type             varchar(50)  NULL,            -- 서비스 정의 값. 저장만
  discount_amount           bigint       NOT NULL DEFAULT 0,
  total_amount              bigint       NOT NULL,        -- 실제 청구액. confirm 시 이 값과 비교
  status                    varchar(20)  NOT NULL DEFAULT 'PENDING',
  expires_at                timestamptz  NOT NULL,        -- 이 시각 이후 confirm 거부
  paid_at                   timestamptz  NULL,
  metadata                  jsonb        NULL,            -- 서비스 맥락. ledger는 해석하지 않음
  created_at                timestamptz  NOT NULL DEFAULT now(),
  updated_at                timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_order PRIMARY KEY (id),
  CONSTRAINT uq_tb_order_external UNIQUE (service_id, external_order_id),
  CONSTRAINT uq_tb_order_id_service UNIQUE (id, service_id),         -- 복합 FK 대상
  CONSTRAINT fk_tb_order_service FOREIGN KEY (service_id) REFERENCES tb_service (id),
  CONSTRAINT ck_tb_order_amounts CHECK (
    original_amount >= 0 AND discount_amount >= 0
    AND total_amount = original_amount - discount_amount
    AND total_amount >= 0
  ),
  CONSTRAINT ck_tb_order_status CHECK (
    status IN ('PENDING', 'PAID', 'PARTIAL_CANCELED', 'CANCELED', 'EXPIRED')
  )
);
CREATE INDEX ix_tb_order_user ON tb_order (service_id, external_user_id, created_at DESC);
CREATE INDEX ix_tb_order_subscription ON tb_order (service_id, external_subscription_id)
  WHERE external_subscription_id IS NOT NULL;
CREATE INDEX ix_tb_order_pending_expiry ON tb_order (expires_at) WHERE status = 'PENDING';

CREATE TABLE tb_order_item (
  id                   uuid         NOT NULL DEFAULT gen_random_uuid(),
  order_id             uuid         NOT NULL,
  service_id           uuid         NOT NULL,             -- 복합 FK용 (주문·상품유형 소유 서비스 일치 강제)
  line_no              smallint     NOT NULL,
  product_type         varchar(50)  NOT NULL,             -- tb_service_product_type 화이트리스트
  external_product_id  varchar(100) NOT NULL,             -- 서비스 쪽 상품 ID
  product_name         varchar(100) NOT NULL,             -- 결제 시점 스냅샷
  unit_price           bigint       NOT NULL,
  quantity             integer      NOT NULL DEFAULT 1,
  amount               bigint       NOT NULL,
  canceled_quantity    integer      NOT NULL DEFAULT 0,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_order_item PRIMARY KEY (id),
  CONSTRAINT uq_tb_order_item_line UNIQUE (order_id, line_no),
  CONSTRAINT fk_tb_order_item_order FOREIGN KEY (order_id, service_id)
    REFERENCES tb_order (id, service_id),
  CONSTRAINT fk_tb_order_item_product_type FOREIGN KEY (service_id, product_type)
    REFERENCES tb_service_product_type (service_id, code),
  CONSTRAINT ck_tb_order_item_amount CHECK (
    unit_price >= 0 AND quantity > 0 AND amount = unit_price * quantity
  ),
  CONSTRAINT ck_tb_order_item_canceled CHECK (canceled_quantity BETWEEN 0 AND quantity)
);


-- =====================================================================
-- 4. 결제 / 취소
-- =====================================================================

CREATE TABLE tb_payment (
  id                    uuid         NOT NULL DEFAULT gen_random_uuid(),
  order_id              uuid         NOT NULL,
  service_id            uuid         NOT NULL,
  billing_key_id        uuid         NULL,                -- BILLING 결제일 때만
  provider              varchar(20)  NOT NULL DEFAULT 'TOSS',
  payment_type          varchar(20)  NOT NULL,            -- NORMAL / BILLING
  idempotency_key       varchar(100) NOT NULL,            -- 토스 호출 시 Idempotency-Key 헤더로도 사용
  provider_payment_key  varchar(200) NULL,                -- 토스 paymentKey (빌링은 응답 후 채워짐)
  method                varchar(30)  NULL,                -- 토스 응답 원문 ('카드', '가상계좌' ...). 분류는 아래 정규화 컬럼 사용
  -- 결제 수단 분류 (토스 응답에서 hub가 정규화해 채운다. 결제 확정 전에는 NULL)
  method_type           varchar(20)  NULL,                -- CARD / VIRTUAL_ACCOUNT / TRANSFER / EASY_PAY / MOBILE_PHONE / GIFT_CERTIFICATE
  card_company_code     varchar(10)  NULL,                -- 토스 카드사 코드 (issuerCode)
  card_type             varchar(10)  NULL,                -- CREDIT / CHECK / GIFT / UNKNOWN
  card_number_masked    varchar(30)  NULL,
  installment_months    smallint     NULL,                -- 0 = 일시불
  easy_pay_provider     varchar(30)  NULL,                -- 토스페이, 카카오페이 ... (토스 easyPay.provider 원문)
  bank_code             varchar(10)  NULL,                -- 가상계좌·계좌이체 은행 코드
  virtual_account_number varchar(30) NULL,                -- 가상계좌 입금 계좌 (서비스가 사용자에게 안내)
  virtual_account_due_at timestamptz NULL,                -- 가상계좌 입금 기한
  currency              char(3)      NOT NULL,
  amount                bigint       NOT NULL,
  refunded_amount       bigint       NOT NULL DEFAULT 0,  -- tb_payment_cancel(DONE) 합계의 캐시
  status                varchar(30)  NOT NULL DEFAULT 'IN_PROGRESS',
  failure_code          varchar(100) NULL,
  failure_message       text         NULL,
  receipt_url           text         NULL,
  provider_response     jsonb        NULL,                -- 마지막 PG 응답 원본 (감사·대사용)
  approved_at           timestamptz  NULL,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_payment PRIMARY KEY (id),
  CONSTRAINT uq_tb_payment_idempotency UNIQUE (service_id, idempotency_key),
  CONSTRAINT uq_tb_payment_provider_key UNIQUE (provider, provider_payment_key),
  CONSTRAINT uq_tb_payment_id_service UNIQUE (id, service_id),
  CONSTRAINT fk_tb_payment_order FOREIGN KEY (order_id, service_id)
    REFERENCES tb_order (id, service_id),
  CONSTRAINT fk_tb_payment_billing_key FOREIGN KEY (billing_key_id, service_id)
    REFERENCES tb_billing_key (id, service_id),
  CONSTRAINT ck_tb_payment_provider CHECK (provider IN ('TOSS')),
  CONSTRAINT ck_tb_payment_type CHECK (
    (payment_type = 'NORMAL'  AND billing_key_id IS NULL) OR
    (payment_type = 'BILLING' AND billing_key_id IS NOT NULL)
  ),
  CONSTRAINT ck_tb_payment_amount CHECK (amount > 0 AND refunded_amount BETWEEN 0 AND amount),
  CONSTRAINT ck_tb_payment_method_type CHECK (method_type IN (
    'CARD', 'VIRTUAL_ACCOUNT', 'TRANSFER', 'EASY_PAY', 'MOBILE_PHONE', 'GIFT_CERTIFICATE'
  )),
  CONSTRAINT ck_tb_payment_card_type CHECK (card_type IN ('CREDIT', 'CHECK', 'GIFT', 'UNKNOWN')),
  CONSTRAINT ck_tb_payment_installment CHECK (installment_months >= 0),
  CONSTRAINT ck_tb_payment_status CHECK (status IN (
    'IN_PROGRESS',          -- 토스 호출 직전에 먼저 저장
    'UNKNOWN',              -- 타임아웃 등 결과 불명 → 대사 배치가 토스 조회로 확정
    'WAITING_FOR_DEPOSIT',  -- 가상계좌 입금 대기 (토스 웹훅으로 DONE 전환)
    'DONE', 'PARTIAL_CANCELED', 'CANCELED',
    'FAILED', 'ABORTED', 'EXPIRED'
  ))
);
-- 한 주문에 "살아있는" 결제는 하나만 (실패한 시도는 여러 번 허용)
CREATE UNIQUE INDEX uq_tb_payment_one_live_per_order ON tb_payment (order_id)
  WHERE status NOT IN ('FAILED', 'ABORTED', 'EXPIRED');
-- 대사 배치 대상
CREATE INDEX ix_tb_payment_reconcile ON tb_payment (updated_at)
  WHERE status IN ('IN_PROGRESS', 'UNKNOWN');

CREATE TABLE tb_payment_cancel (
  id                        uuid         NOT NULL DEFAULT gen_random_uuid(),
  payment_id                uuid         NOT NULL,
  service_id                uuid         NOT NULL,
  idempotency_key           varchar(100) NOT NULL,        -- 서비스가 보낸 값. 재시도 시 같은 결과 반환
  amount                    bigint       NOT NULL,
  reason_code               varchar(50)  NOT NULL,        -- 서비스 정의 값
  reason_detail             varchar(200) NULL,            -- 토스 cancelReason으로 전달
  requested_by              varchar(20)  NOT NULL,
  status                    varchar(20)  NOT NULL DEFAULT 'REQUESTED',
  provider_transaction_key  varchar(200) NULL,            -- 토스 cancels[].transactionKey
  failure_code              varchar(100) NULL,
  failure_message           text         NULL,
  canceled_at               timestamptz  NULL,
  created_at                timestamptz  NOT NULL DEFAULT now(),
  updated_at                timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_payment_cancel PRIMARY KEY (id),
  CONSTRAINT uq_tb_payment_cancel_idempotency UNIQUE (service_id, idempotency_key),
  CONSTRAINT uq_tb_payment_cancel_tx_key UNIQUE (provider_transaction_key),
  CONSTRAINT fk_tb_payment_cancel_payment FOREIGN KEY (payment_id, service_id)
    REFERENCES tb_payment (id, service_id),
  CONSTRAINT ck_tb_payment_cancel_amount CHECK (amount > 0),
  CONSTRAINT ck_tb_payment_cancel_requested_by CHECK (requested_by IN ('SERVICE', 'ADMIN', 'SYSTEM')),
  CONSTRAINT ck_tb_payment_cancel_status CHECK (status IN ('REQUESTED', 'UNKNOWN', 'DONE', 'FAILED'))
);
CREATE INDEX ix_tb_payment_cancel_payment ON tb_payment_cancel (payment_id);

-- 부분 환불 시 어떤 항목을 몇 개 취소했는지 (선택 입력)
CREATE TABLE tb_payment_cancel_item (
  cancel_id      uuid     NOT NULL,
  order_item_id  uuid     NOT NULL,
  quantity       integer  NOT NULL,
  amount         bigint   NOT NULL,
  CONSTRAINT pk_tb_payment_cancel_item PRIMARY KEY (cancel_id, order_item_id),
  CONSTRAINT fk_tb_payment_cancel_item_cancel FOREIGN KEY (cancel_id) REFERENCES tb_payment_cancel (id),
  CONSTRAINT fk_tb_payment_cancel_item_item FOREIGN KEY (order_item_id) REFERENCES tb_order_item (id),
  CONSTRAINT ck_tb_payment_cancel_item CHECK (quantity > 0 AND amount >= 0)
);


-- =====================================================================
-- 5. 원장 (복식부기, append-only)
--
--  결제 승인  : 차) PG_RECEIVABLE        / 대) REVENUE
--  결제 취소  : 차) REFUND (매출 차감)   / 대) PG_RECEIVABLE
--  PG 정산 입금: 차) CASH + PG_FEE       / 대) PG_RECEIVABLE
-- =====================================================================

CREATE TABLE tb_ledger_account (
  id          uuid         NOT NULL DEFAULT gen_random_uuid(),
  service_id  uuid         NULL,                          -- NULL = 회사 공통 계정 (CASH 등)
  code        varchar(50)  NOT NULL,                      -- PG_RECEIVABLE, REVENUE, REFUND, PG_FEE, CASH
  type        varchar(20)  NOT NULL,
  currency    char(3)      NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_ledger_account PRIMARY KEY (id),
  CONSTRAINT uq_tb_ledger_account UNIQUE NULLS NOT DISTINCT (service_id, code, currency),
  CONSTRAINT fk_tb_ledger_account_service FOREIGN KEY (service_id) REFERENCES tb_service (id),
  CONSTRAINT ck_tb_ledger_account_type CHECK (
    type IN ('ASSET', 'LIABILITY', 'REVENUE', 'CONTRA_REVENUE', 'EXPENSE')
  )
);

CREATE TABLE tb_ledger_transaction (
  id                uuid         NOT NULL DEFAULT gen_random_uuid(),
  service_id        uuid         NULL,
  transaction_type  varchar(30)  NOT NULL,
  reference_type    varchar(30)  NOT NULL,                -- PAYMENT / PAYMENT_CANCEL / SETTLEMENT
  reference_id      uuid         NOT NULL,
  description       varchar(200) NULL,
  occurred_at       timestamptz  NOT NULL,                -- 사건 발생 시각 (토스 approvedAt 등)
  created_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_ledger_transaction PRIMARY KEY (id),
  -- 같은 사건이 두 번 기장되지 않도록
  CONSTRAINT uq_tb_ledger_transaction_ref UNIQUE (transaction_type, reference_type, reference_id),
  CONSTRAINT fk_tb_ledger_transaction_service FOREIGN KEY (service_id) REFERENCES tb_service (id),
  CONSTRAINT ck_tb_ledger_transaction_type CHECK (
    transaction_type IN ('PAYMENT_CAPTURED', 'PAYMENT_CANCELED', 'PG_SETTLED', 'ADJUSTMENT')
  )
);
CREATE INDEX ix_tb_ledger_transaction_occurred ON tb_ledger_transaction (service_id, occurred_at);

CREATE TABLE tb_ledger_entry (
  id              uuid         NOT NULL DEFAULT gen_random_uuid(),
  transaction_id  uuid         NOT NULL,
  account_id      uuid         NOT NULL,
  direction       varchar(6)   NOT NULL,
  amount          bigint       NOT NULL,
  currency        char(3)      NOT NULL,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_ledger_entry PRIMARY KEY (id),
  CONSTRAINT fk_tb_ledger_entry_tx FOREIGN KEY (transaction_id) REFERENCES tb_ledger_transaction (id),
  CONSTRAINT fk_tb_ledger_entry_account FOREIGN KEY (account_id) REFERENCES tb_ledger_account (id),
  CONSTRAINT ck_tb_ledger_entry_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
  CONSTRAINT ck_tb_ledger_entry_amount CHECK (amount > 0)
);
CREATE INDEX ix_tb_ledger_entry_tx ON tb_ledger_entry (transaction_id);
CREATE INDEX ix_tb_ledger_entry_account ON tb_ledger_entry (account_id, created_at);

-- 차변 합 = 대변 합 (트랜잭션 커밋 시점에 검사)
CREATE OR REPLACE FUNCTION fn_ledger_check_balanced() RETURNS trigger AS $$
DECLARE
  v_debit  bigint;
  v_credit bigint;
BEGIN
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0),
         COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)
    INTO v_debit, v_credit
    FROM tb_ledger_entry
   WHERE transaction_id = NEW.transaction_id;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'ledger transaction % unbalanced: debit=% credit=%',
      NEW.transaction_id, v_debit, v_credit;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_ledger_entry_balanced
  AFTER INSERT ON tb_ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_check_balanced();

-- 원장은 수정·삭제 불가. 잘못된 기장은 반대 분개(ADJUSTMENT)로 바로잡는다.
CREATE OR REPLACE FUNCTION fn_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_transaction_append_only
  BEFORE UPDATE OR DELETE ON tb_ledger_transaction
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_append_only();
CREATE TRIGGER trg_ledger_entry_append_only
  BEFORE UPDATE OR DELETE ON tb_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_append_only();


-- =====================================================================
-- 6. 이벤트 (Transactional Outbox → 서비스 웹훅) / 토스 웹훅 수신
-- =====================================================================

-- 결제 "사실"만 담는 범용 이벤트. 결제/취소 저장과 같은 DB 트랜잭션에서 INSERT.
-- 서비스별 비즈니스 이벤트(호스팅 생성 등)는 서비스가 이 이벤트를 받아 스스로 처리한다.
CREATE TABLE tb_outbox_event (
  id              uuid         NOT NULL DEFAULT gen_random_uuid(),
  service_id      uuid         NOT NULL,
  event_type      varchar(50)  NOT NULL,
  aggregate_type  varchar(30)  NOT NULL,                  -- ORDER / PAYMENT / PAYMENT_CANCEL
  aggregate_id    uuid         NOT NULL,
  payload         jsonb        NOT NULL,
  occurred_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_outbox_event PRIMARY KEY (id),
  CONSTRAINT fk_tb_outbox_event_service FOREIGN KEY (service_id) REFERENCES tb_service (id),
  CONSTRAINT ck_tb_outbox_event_type CHECK (event_type IN (
    'PAYMENT_CONFIRMED', 'PAYMENT_FAILED', 'PAYMENT_WAITING_FOR_DEPOSIT',
    'PAYMENT_CANCELED', 'ORDER_EXPIRED'
  ))
);
CREATE INDEX ix_tb_outbox_event_aggregate ON tb_outbox_event (aggregate_type, aggregate_id);
-- 이벤트 재조회 (GET /events?after=): 서비스별 발행 순서
CREATE INDEX ix_tb_outbox_event_service_feed ON tb_outbox_event (service_id, occurred_at, id);

-- =====================================================================
-- 7. 관리자 감사 로그 (db/schema.sql 끝에 추가)
--    admin 레포를 통한 모든 관리 작업(쓰기)을 기록. append-only.
-- =====================================================================

CREATE TABLE tb_admin_audit_log (
  id           uuid          NOT NULL DEFAULT gen_random_uuid(),
  actor_id     varchar(100)  NOT NULL,                  -- admin 레포의 관리자 ID (X-Admin-Actor-Id)
  actor_name   varchar(100)  NULL,
  action       varchar(50)   NOT NULL,
  target_type  varchar(30)   NOT NULL,                  -- SERVICE / API_KEY / PG_CREDENTIAL / PRODUCT_TYPE / PAYMENT / WEBHOOK_DELIVERY ...
  target_id    varchar(100)  NOT NULL,
  service_id   uuid          NULL,                      -- 대상이 속한 서비스
  before       jsonb         NULL,                      -- 변경 전 (비밀값 제외)
  after        jsonb         NULL,                      -- 변경 후 (비밀값 제외)
  reason       varchar(200)  NULL,                      -- 수동 환불·정지 등 사유
  request_id   varchar(100)  NULL,
  ip           varchar(45)   NULL,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_admin_audit_log PRIMARY KEY (id),
  CONSTRAINT fk_tb_admin_audit_log_service FOREIGN KEY (service_id) REFERENCES tb_service (id),
  CONSTRAINT ck_tb_admin_audit_log_action CHECK (action IN (
    'SERVICE_CREATED', 'SERVICE_UPDATED', 'SERVICE_SUSPENDED', 'SERVICE_RESUMED', 'SERVICE_DELETED',
    'API_KEY_ISSUED', 'API_KEY_REVOKED',
    'PG_CREDENTIAL_REGISTERED', 'PG_CREDENTIAL_DEACTIVATED',
    'PRODUCT_TYPE_CREATED', 'PRODUCT_TYPE_UPDATED',
    'WEBHOOK_CONFIG_UPDATED', 'WEBHOOK_SECRET_ROTATED', 'WEBHOOK_REDELIVERED',
    'PAYMENT_CANCELED_BY_ADMIN', 'PAYMENT_RECONCILED'
  ))
);
CREATE INDEX ix_tb_admin_audit_log_target ON tb_admin_audit_log (target_type, target_id, created_at DESC);
CREATE INDEX ix_tb_admin_audit_log_service ON tb_admin_audit_log (service_id, created_at DESC);
CREATE INDEX ix_tb_admin_audit_log_actor ON tb_admin_audit_log (actor_id, created_at DESC);

CREATE TRIGGER trg_admin_audit_log_append_only
  BEFORE UPDATE OR DELETE ON tb_admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_append_only();   -- 원장과 같은 append-only 함수 재사용

-- 전달 시도 상태. 이벤트(불변 사실)와 전달(가변 상태)을 분리.
CREATE TABLE tb_webhook_delivery (
  id                uuid         NOT NULL DEFAULT gen_random_uuid(),
  event_id          uuid         NOT NULL,
  service_id        uuid         NOT NULL,
  target_url        text         NOT NULL,                -- 발행 시점 URL 스냅샷
  status            varchar(20)  NOT NULL DEFAULT 'PENDING',
  attempt_count     integer      NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz  NOT NULL DEFAULT now(),
  locked_until      timestamptz  NULL,                    -- 처리 중 인스턴스가 죽으면 이 시각 이후 재획득
  last_http_status  integer      NULL,
  last_error        text         NULL,
  delivered_at      timestamptz  NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_webhook_delivery PRIMARY KEY (id),
  CONSTRAINT uq_tb_webhook_delivery_event UNIQUE (event_id, service_id),
  CONSTRAINT fk_tb_webhook_delivery_event FOREIGN KEY (event_id) REFERENCES tb_outbox_event (id),
  CONSTRAINT fk_tb_webhook_delivery_service FOREIGN KEY (service_id) REFERENCES tb_service (id),
  CONSTRAINT ck_tb_webhook_delivery_status CHECK (
    status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'RETRYING', 'DEAD')
  )
);
-- 폴러: SELECT ... WHERE status IN (...) AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED
CREATE INDEX ix_tb_webhook_delivery_due ON tb_webhook_delivery (next_attempt_at)
  WHERE status IN ('PENDING', 'RETRYING', 'PROCESSING');

-- 토스 → ledger 웹훅 수신 로그 (가상계좌 입금, 상태 변경 등)
CREATE TABLE tb_pg_webhook_event (
  id            uuid          NOT NULL DEFAULT gen_random_uuid(),
  provider      varchar(20)   NOT NULL DEFAULT 'TOSS',
  event_type    varchar(50)   NOT NULL,
  dedup_key     varchar(200)  NOT NULL,                   -- 중복 수신 방지 키 (paymentKey + 상태 + 시각 등)
  payload       jsonb         NOT NULL,
  status        varchar(20)   NOT NULL DEFAULT 'RECEIVED',
  error         text          NULL,
  received_at   timestamptz   NOT NULL DEFAULT now(),
  processed_at  timestamptz   NULL,
  CONSTRAINT pk_tb_pg_webhook_event PRIMARY KEY (id),
  CONSTRAINT uq_tb_pg_webhook_event_dedup UNIQUE (provider, dedup_key),
  CONSTRAINT ck_tb_pg_webhook_event_status CHECK (
    status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')
  )
);


-- =====================================================================
-- updated_at 트리거 일괄 등록
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tb_service', 'tb_pg_credential', 'tb_service_product_type', 'tb_billing_key',
    'tb_order', 'tb_order_item', 'tb_payment', 'tb_payment_cancel', 'tb_webhook_delivery'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I
         FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at()', t);
  END LOOP;
END $$;
