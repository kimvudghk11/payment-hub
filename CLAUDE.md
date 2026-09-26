# payment-hub

여러 서비스의 결제를 하나로 모으는 결제 허브 서버.
토스페이먼츠 연동, 결제 이력, 복식부기 원장, 결제 이벤트 전달을 한 곳에서 책임진다.

- Stack: NestJS 11 · TypeScript · PostgreSQL 15+ · TypeORM 0.3 · class-validator · @nestjs/schedule · Swagger
- PG: 토스페이먼츠 (일반 결제, 빌링 자동결제, 가상계좌)
- DB 스키마 원본: `db/schema.sql` ← **스키마의 단일 진실 공급원(SSOT). 엔티티는 이 파일을 따른다.**

---

## 1. 이 프로젝트가 푸는 문제

여러 서비스를 운영하는 조직에서 서비스마다 PG 연동 코드, 키 관리, 결제 이력이 흩어져 있으면
중복 코드, 결제 상태 불일치, 결제 응답 지연(결제 후 후속 작업이 동기로 묶임)이 생긴다.

payment-hub는 **"결제만"** 중앙화한다. 주문 서버를 별도로 두지 않고,
주문 도메인은 각 서비스가 들고 결제 허브에는 결제에 필요한 값만 넘긴다.

```
대기업형:   서비스 → 주문 서버 → 결제 서버 → 서비스
이 프로젝트: 서비스(+주문) → payment-hub → 서비스(웹훅)
```

작은 조직이 여러 서비스를 운영할 때 주문 서버까지 분리하는 비용은 과하다고 판단했다.

---

## 2. 책임 경계

| 항목 | payment-hub | 각 서비스 |
|------|-------------|-----------|
| 상품·구독·포인트·쿠폰 관리 | — | 직접 관리 |
| 상품 유효성·할인·금액 계산 | — | 직접 계산 후 결과만 전달 |
| 상품 유형 검증 | 화이트리스트(`tb_service_product_type`)로만 검증 | 유형 등록 |
| 주문 금액 무결성 | 사전 등록 금액 고정, confirm 시 금액 대조 | — |
| 토스 API 호출 (승인·빌링·취소·조회) | 전담 | — |
| 결제·취소 이력, 원장 기장 | 전담 | — |
| 환불 금액 계산 (일할 등) | — | 정책 판단 후 금액 전달 |
| 정기결제 스케줄·재시도 정책 | — | 배치 실행 후 빌링 요청만 보냄 |
| 결제 후 후속 처리 (프로비저닝 등) | 범용 이벤트 발행만 | 이벤트 수신 후 직접 처리. 실패 시 직접 cancel 요청 |

**payment-hub는 서비스의 비즈니스를 모른다.** 서비스 고유 이벤트명, 서비스별 분기 코드를 hub에 넣지 않는다.
새 서비스 연동은 "서비스 등록 + API 키 발급 + 상품 유형 등록 + PG 자격증명 등록"만으로 끝나야 한다.

---

## 3. 설계 원칙

1. **금액은 bigint, 통화 최소 단위(minor unit).** KRW 10,000원 = `10000`, USD $12.34 = `1234`. 소수·float 금지.
2. **ledger가 분기하는 값만 제한한다.** 상태 머신·내부 분기 값은 `varchar + CHECK`. 서비스가 자유롭게 정의하는 값(`discount_type`, `reason_code`, `metadata` 등)은 제한 없이 저장만 한다. PostgreSQL enum 타입은 마이그레이션 부담 때문에 쓰지 않는다.
3. **서비스 소유권은 DB가 강제한다.** 주문·항목·결제·취소·빌링키는 `(id, service_id)` 복합 FK로 연결된다. 코드 버그가 있어도 서비스 B가 서비스 A의 자원을 건드릴 수 없다.
4. **외부 호출 전에 먼저 기록한다.** 토스 호출 전 `IN_PROGRESS`/`REQUESTED`로 저장 → 호출 → 결과 반영. 결과를 모르면 `UNKNOWN`으로 두고 대사 배치가 확정한다. "돈은 나갔는데 기록이 없는" 상태를 만들지 않는다.
5. **모든 쓰기 요청은 멱등하다.** 주문 생성은 `(service_id, external_order_id)`, 결제는 `(service_id, idempotency_key)`(토스 `Idempotency-Key` 헤더로도 전달), 취소는 `(service_id, idempotency_key)`. 멱등키는 서비스가 정하는 값이므로 항상 서비스 단위로 유일하다. 같은 키로 재요청하면 에러가 아니라 기존 결과를 반환한다.
6. **원장은 append-only 복식부기.** 차변 합 = 대변 합을 커밋 시점 트리거로 강제. UPDATE/DELETE는 트리거로 차단. 잘못된 기장은 `ADJUSTMENT` 반대 분개로만 정정한다.
7. **상태 변경과 이벤트 발행은 같은 트랜잭션.** Transactional Outbox 패턴. 결제/취소 저장과 `tb_outbox_event` INSERT를 한 트랜잭션으로 묶는다.
8. **비밀값은 암호화 저장.** 토스 시크릿 키, 빌링키, 웹훅 서명 키는 `*_enc bytea` + 암호화 키 ID(`*_key_id`)로 저장. API 키는 SHA-256 해시만 저장하고 평문은 발급 시 1회만 응답한다.
9. **도메인 규칙은 엔티티 안에.** 불변식 검증과 상태 전이는 서비스 레이어가 아니라 엔티티 메서드가 책임진다(5장 참고).

---

## 4. 스키마 개요

```
[서비스]  tb_service ─┬─ tb_service_api_key       서비스→hub 인증. 서비스당 여러 키(무중단 교체)
                      ├─ tb_pg_credential          서비스·환경(TEST/LIVE)별 토스 키. 활성 1개
                      └─ tb_service_product_type   상품 유형 화이트리스트 (카탈로그 아님)
[수단]    tb_billing_key                           빌링키(암호화) + 마스킹 카드 정보
[주문]    tb_order ── tb_order_item                서비스가 사전 등록. 금액 고정. 항목은 결제 시점 스냅샷
[결제]    tb_payment ── tb_payment_cancel ── tb_payment_cancel_item
[원장]    tb_ledger_account / tb_ledger_transaction ── tb_ledger_entry
[이벤트]  tb_outbox_event ── tb_webhook_delivery   hub → 서비스 (불변 이벤트 / 가변 전달 상태 분리)
          tb_pg_webhook_event                      토스 → hub (가상계좌 입금 등). dedup_key로 중복 수신 방지
[관리]    tb_admin_audit_log                       admin 레포를 통한 모든 관리 작업 기록. append-only
```

### 상태 머신

- `tb_order.status`: `PENDING → PAID → PARTIAL_CANCELED → CANCELED`, `PENDING → EXPIRED`
- `tb_payment.status`: `IN_PROGRESS → DONE | FAILED | ABORTED | UNKNOWN | WAITING_FOR_DEPOSIT`,
  `UNKNOWN → (대사) → DONE | FAILED`, `WAITING_FOR_DEPOSIT → DONE | EXPIRED`,
  `DONE → PARTIAL_CANCELED → CANCELED`
- `tb_payment_cancel.status`: `REQUESTED → DONE | FAILED | UNKNOWN`
- `tb_webhook_delivery.status`: `PENDING → PROCESSING → SUCCEEDED | RETRYING → … → DEAD`

한 주문에 "살아있는" 결제(`FAILED/ABORTED/EXPIRED` 제외)는 하나만 존재한다 (부분 유니크 인덱스).

### 결제 수단 분류

`tb_payment.method`는 토스 응답 원문이고, 조회 필터·리포트 분류에는 hub가 정규화한 컬럼을 쓴다.
`method_type`(CARD / VIRTUAL_ACCOUNT / TRANSFER / EASY_PAY / MOBILE_PHONE / GIFT_CERTIFICATE)과 `card_type`(CREDIT / CHECK / GIFT / UNKNOWN)은 hub가 분기하므로 CHECK로 제한하고,
카드사 코드·은행 코드·간편결제사처럼 토스가 정의하는 값은 원문 그대로 저장한다. 결제 확정 전(`IN_PROGRESS`)에는 모두 NULL.

### 원장 분개 규칙

| 사건 | 차변 (DEBIT) | 대변 (CREDIT) |
|------|-------------|---------------|
| 결제 승인 `PAYMENT_CAPTURED` | PG_RECEIVABLE | REVENUE |
| 결제 취소 `PAYMENT_CANCELED` | REFUND (매출 차감) | PG_RECEIVABLE |
| PG 정산 입금 `PG_SETTLED` | CASH + PG_FEE | PG_RECEIVABLE |

`tb_ledger_transaction`은 `(transaction_type, reference_type, reference_id)` 유니크 → 같은 사건 이중 기장 불가.
매출·정산 리포트는 별도 집계 테이블 없이 `tb_ledger_entry`에서 집계한다. 성능 문제가 생기면 그때 집계 테이블을 추가한다.

### DB로 강제하지 못해 앱이 지켜야 하는 규칙

- `sum(order_item.amount) = order.original_amount` → `Order.create()`에서 검증
- `refunded_amount` 갱신과 환불 가능 금액 검증 → `SELECT ... FOR UPDATE`로 payment 락 후 `Payment.cancel()`
- `order_item.canceled_quantity` 누적 → 취소 항목 기록 시 같은 트랜잭션에서 갱신
- 원장 기장은 결제/취소 상태 변경과 같은 트랜잭션

---

## 5. 주요 흐름

### 일반 결제
1. 서비스 서버 → `POST /orders` (서버 간 호출, API 키 인증). 항목·금액 검증 후 `PENDING`, `expires_at` 설정.
2. 서비스 프론트가 `tb_order.id`를 토스 `orderId`로 결제창 호출.
3. 서비스 서버 → `POST /payments/confirm { orderId, paymentKey, amount }`
   - 주문 소유 서비스 == 요청 서비스, 상태 `PENDING`, 만료 전, `amount == total_amount` 검증
   - `tb_payment` `IN_PROGRESS` 저장 → 토스 승인 호출
   - 성공: payment `DONE`, order `PAID`, 원장 기장, outbox `PAYMENT_CONFIRMED` (한 트랜잭션)
   - 타임아웃: payment `UNKNOWN` → 대사 배치가 토스 조회 API로 확정
4. 응답은 즉시 반환. 후속 처리는 웹훅으로 비동기.

### 빌링(자동결제)
서비스 배치가 대상·재시도 정책을 판단 → 주문 등록 → `POST /payments/billing`. 이후는 일반 결제와 같다.

### 환불
서비스가 금액 계산 → `POST /payments/:id/cancel { amount, reasonCode, idempotencyKey, items? }`
→ payment 락 → `Payment.cancel()` 검증 → cancel `REQUESTED` 저장 → 토스 취소 호출(멱등키 포함)
→ 성공 시 cancel `DONE`, payment 상태·`refunded_amount` 갱신, 원장 반대 분개, outbox `PAYMENT_CANCELED`.

### hub → 서비스 웹훅
- 폴러가 `FOR UPDATE SKIP LOCKED`로 due 건 획득 (다중 인스턴스 안전), `locked_until`로 죽은 워커 복구
- 요청 본문은 서비스별 `webhook_secret`으로 HMAC 서명. 서비스는 서명 검증 + `event_id` 기준 멱등 처리
- 2xx가 아니면 지수 백오프로 재시도, 한도 초과 시 `DEAD` → 어드민 재전송 대상
- **전달 실패로 환불하지 않는다.** 전달 실패는 재시도 대상이고, 비즈니스 실패는 서비스가 판단해 cancel을 요청한다.

### 토스 → hub 웹훅
가상계좌 입금 등 비동기 상태 변경 수신. `dedup_key`로 중복 무시, 페이로드를 그대로 신뢰하지 말고 토스 조회 API로 재확인 후 반영.

---

## 6. 관리자(admin)와 조회 API

payment-hub는 호출 주체가 둘이고, API 표면도 둘로 완전히 나뉜다.
**엔드포인트별 요청·응답 계약의 기준은 [`docs/api.md`](docs/api.md)다.** API를 추가·변경하면 같은 커밋에서 이 문서의 상태 표시(✅/🚧)와 계약을 갱신한다.

**배포 하나 = PG 환경 하나.** TEST hub와 LIVE hub는 DB까지 분리해 띄우고, 각 배포는 env `PG_ENVIRONMENT`에 맞는 PG 자격증명과 API 키 prefix(`ph_test_` / `ph_live_`)만 쓴다. 결제·원장 테이블에 환경 컬럼이 없는 이유다(테스트 결제가 운영 리포트에 섞이지 않음).

| | 서비스 API | 관리자 API |
|---|---|---|
| 경로 | `/api/v1/*` | `/api/v1/admin/*` |
| 호출자 | 각 서비스 서버 | admin 레포(관리자 백엔드) |
| 인증 | 서비스 API 키 | admin 키 + 관리자 식별 헤더 |
| 데이터 범위 | **자기 서비스 것만** | 전 서비스 |
| 할 수 있는 일 | 주문·결제·환불 요청, 자기 결제 이력 조회 | 서비스 등록·키 관리·설정, 전체 조회, 운영 처리 |
| 관리성 쓰기 | **불가** | 가능 (전부 감사 로그) |

### 6.1 admin 레포와의 계약

- 관리자 로그인·권한(RBAC)은 **admin 레포가 책임진다.** hub는 관리자 계정을 모른다.
- admin 레포는 hub DB에 직접 접근하지 않는다. **오직 `/admin/*` API로만** 관리한다. (DB 직접 수정은 감사 로그와 도메인 규칙을 우회하므로 금지)
- 호출 헤더:
  - `Authorization: Bearer <admin_api_key>` — admin 레포 서버 전용 키. hub는 env `ADMIN_API_KEY_HASHES`(SHA-256, 쉼표 구분)로 검증. 여러 개 허용 → 무중단 교체
  - `X-Admin-Actor-Id` (필수) — 작업한 관리자 ID. 감사 로그 `actor_id`
  - `X-Admin-Actor-Name` (선택, URL 인코딩)
  - `X-Request-Id` (선택) — admin 레포와 로그 추적 연결
- hub는 actor 헤더를 admin 레포가 인증했다고 **신뢰**한다. 그래서 admin API는 네트워크 레벨에서도 막는다(내부망 / IP 허용 목록). 서비스 API와 같은 공개 경로로 노출하지 않는 것을 원칙으로 한다.

### 6.2 관리자 API — 서비스·키 관리

| 기능 | API | 비고 |
|------|-----|------|
| 서비스 등록 | `POST /admin/services` | code, name, webhook_url |
| 서비스 수정 | `PATCH /admin/services/:id` | 이름, webhook_url |
| 서비스 정지 / 재개 | `POST /admin/services/:id/suspend`, `/resume` | 정지 시 키가 유효해도 서비스 API 전부 `SERVICE_SUSPENDED` |
| 서비스 삭제 | `DELETE /admin/services/:id` | soft delete(`deleted_at`). 결제 이력은 보존 |
| API 키 발급 | `POST /admin/services/:id/api-keys` | label, expires_at. **평문은 이 응답에서 1회만** 반환 |
| API 키 목록 | `GET /admin/services/:id/api-keys` | prefix, hint, 만료, 마지막 사용 시각만. 해시 미노출 |
| API 키 폐기 | `POST /admin/api-keys/:id/revoke` | 교체 절차: 새 키 발급 → 서비스 배포 → 구 키 `last_used_at` 멈춤 확인 → 구 키 폐기 |
| PG 자격증명 등록 | `POST /admin/services/:id/pg-credentials` | 시크릿 키 평문을 받아 암호화 저장. 기존 활성 키는 같은 트랜잭션에서 비활성 |
| PG 자격증명 조회 | `GET /admin/services/:id/pg-credentials` | mId, client_key, hint, 환경만. 시크릿 키는 **어떤 경우에도 반환하지 않음** |
| 상품 유형 관리 | `POST/PATCH /admin/services/:id/product-types` | 삭제 대신 `is_active=false` (기존 주문 항목이 FK로 참조) |
| 웹훅 서명 키 교체 | `POST /admin/services/:id/webhook-secret/rotate` | 새 키 평문 1회 반환 |

### 6.3 관리자 API — 조회·운영

| 기능 | API | 비고 |
|------|-----|------|
| 전체 결제 검색 | `GET /admin/payments` | 서비스, 상태, 기간, external_user_id, external_order_id, paymentKey 필터 |
| 결제 상세 | `GET /admin/payments/:id` | 주문·항목, 취소 이력, 원장 분개, 웹훅 전달 내역, PG 응답 원본까지 한 번에 |
| 수동 환불 | `POST /admin/payments/:id/cancel` | 서비스 cancel과 같은 도메인 로직, `requested_by='ADMIN'`, 사유 필수 |
| 대사 대기 결제 | `GET /admin/ops/unknown-payments` | `IN_PROGRESS`·`UNKNOWN` 오래된 순 |
| 수동 대사 | `POST /admin/ops/payments/:id/reconcile` | 토스 조회 API로 상태 확정 |
| 실패 웹훅 | `GET /admin/ops/webhook-deliveries?status=DEAD` | |
| 웹훅 재전송 | `POST /admin/ops/webhook-deliveries/:id/redeliver` | 상태를 `PENDING`으로, `attempt_count`는 유지 |
| 실패한 토스 웹훅 | `GET /admin/ops/pg-webhooks?status=FAILED` | |
| 매출·환불 집계 | `GET /admin/reports/revenue` | 서비스별·일별·월별. `tb_ledger_entry` 기준, **KST 날짜 경계** |
| 감사 로그 | `GET /admin/audit-logs` | actor, 대상, 서비스, 기간 필터 |

### 6.4 서비스 API — 결제 이력 조회

서비스는 **읽기 전용으로 자기 서비스 데이터만** 본다. 가드가 넣어준 `req.serviceId`를 모든 쿼리 조건에 강제하고, 다른 서비스의 ID로 조회하면 `RESOURCE_NOT_FOUND`(404)로 응답해 존재 자체를 숨긴다.

| 기능 | API | 비고 |
|------|-----|------|
| 주문 단건 | `GET /orders/:id` 또는 `GET /orders?externalOrderId=` | 서비스 자기 주문번호로도 조회 |
| 주문·결제 목록 | `GET /orders` | external_user_id, external_subscription_id, 상태, 기간 필터 |
| 결제 단건 | `GET /payments/:id` | 결제 + 취소 이력 + 환불 가능 금액 |
| 구독 결제 체인 | `GET /orders?externalSubscriptionId=` | 서비스가 일할 환불 금액을 계산할 때 사용 |
| 이벤트 재조회 | `GET /events?after=<event_id>` | 웹훅을 놓쳤을 때 서비스가 직접 따라잡는 용도 (발생 순서대로) |

서비스 응답에서 **빼는 것**: PG 응답 원본(`provider_response`), 원장 분개, 다른 서비스 정보, 대사 처리 내부 상세, 감사 로그.
목록 조회는 cursor 기반 페이징(`created_at`, `id`)을 기본으로 한다. offset은 데이터가 쌓이면 느려지고 중간 삽입 시 누락·중복이 생긴다.

### 6.5 감사 로그 (`tb_admin_audit_log`)

- admin API의 **모든 쓰기**는 같은 DB 트랜잭션에서 감사 로그를 남긴다. 조회는 남기지 않는다.
- `before`/`after`에 변경 전후를 jsonb로 남기되 비밀값(시크릿 키, 키 해시, 서명 키)은 제외.
- append-only. UPDATE/DELETE는 트리거로 차단된다.
- 수동 환불·서비스 정지처럼 영향이 큰 작업은 `reason` 필수.

---

## 7. 폴더 구조

```
src
├── common/                 domain(BaseEntity), database(transformer), errors, filters, guards, interceptors, decorators, utils, crypto
├── pg/                     토스 API 클라이언트 (승인·빌링·취소·조회). 다른 모듈이 주입받아 사용
├── service/                서비스·API 키·PG 자격증명·상품 유형 관리, ApiKeyGuard
├── billing-key/            빌링키 발급·조회·폐기
├── order/                  주문 사전 등록·조회·만료
├── payment/                confirm·billing·cancel, 대사 배치
├── ledger/                 계정·분개 기장, 집계 조회
├── outbox/                 outbox 이벤트, 웹훅 전달 폴러
├── pg-webhook/             토스 웹훅 수신
└── admin/                  관리자 전용 API (/api/v1/admin/*). 6장 참고
    ├── service/            서비스·API 키·PG 자격증명·상품 유형·웹훅 설정 관리
    ├── payment/            전 서비스 결제 조회, 수동 환불
    ├── ops/                운영 큐: UNKNOWN 결제 대사, DEAD 웹훅 재전송, 실패한 토스 웹훅
    ├── report/             원장 기반 매출·환불 집계
    └── audit/              감사 로그 기록·조회
```

도메인 모듈 내부 구조:

```
<domain>/
├── constants/          상태 값, 상수 (DB CHECK 값과 반드시 일치)
├── domain/             엔티티 (TypeORM 엔티티 = 도메인 엔티티, 행위 메서드 포함)
├── dto/
│   ├── request/
│   └── response/
├── <domain>.controller.ts
├── <domain>.module.ts
└── <domain>.service.ts   유스케이스 조율 (트랜잭션, 락, 외부 호출 순서)
```

---

## 8. 코딩 컨벤션

### 엔티티 (DDD)
- 베이스 클래스는 테이블의 시간 컬럼 구성에 맞춰 고른다 (`src/common/domain/`). 테이블에 없는 컬럼을 상속하면 TypeORM이 SQL에 포함시켜 실패하므로, nullable로 대신할 수 없다.
  - `created_at` + `updated_at` → `BaseEntity`
  - `created_at`만 (API 키, 원장, 감사 로그) → `CreatedAtEntity`
  - 그 외 (`tb_payment_cancel_item`, `tb_outbox_event`, `tb_pg_webhook_event`) → 상속 없이 자기 컬럼 선언
- PK는 uuid: `@PrimaryGeneratedColumn('uuid', { name: 'id' })`, 코드 프로퍼티명은 `[domain]Id`.
- 모든 `@Column`에 `name`과 `type`(문자열은 `length`까지)을 명시한다. 금액 bigint 컬럼은 `bigintAmountTransformer` 필수.
- **객체 관계는 애그리거트 내부만** (Order→OrderItem, Payment→PaymentCancel→PaymentCancelItem, LedgerTransaction→LedgerEntry). 다른 애그리거트는 ID 컬럼으로만 참조한다. 복합 FK는 `@JoinColumn([...])`으로 `(id, service_id)`를 함께 매핑한다.
- 순환 import 방지: 부모는 자식을 값으로 import, 자식은 부모를 문자열 이름(`@ManyToOne('Order', ...)`) + `import type`으로 참조한다.
- **생성은 정적 팩토리** (`Order.create(...)`, `Payment.start(...)`). 팩토리에서 불변식 검증.
- **상태 변경은 행위 메서드로만** (`payment.markDone(...)`, `payment.cancel(amount, reason)`, `order.markPaid()`). 서비스 레이어에서 `entity.status = ...` 직접 대입 금지.
- 잘못된 상태 전이는 엔티티가 예외를 던진다.
- 계산 값은 getter (`payment.refundableAmount`).

```ts
cancel(cancelAmount: number, reasonCode: string): PaymentCancel {
  if (!this.isCancelable()) throw new BusinessException(ErrorCode.PAYMENT_NOT_CANCELABLE);
  if (cancelAmount > this.refundableAmount) {
    throw new BusinessException(ErrorCode.CANCEL_AMOUNT_EXCEEDED, { refundableAmount: this.refundableAmount });
  }
  // ...
}
```

### 금액과 bigint
- `pg` 드라이버는 bigint를 **문자열로** 반환한다. 금액 컬럼에는 공통 transformer를 달아 number로 변환하고, `Number.MAX_SAFE_INTEGER` 초과 시 예외를 던진다.

### DTO
- `class-validator` + `@ApiProperty({ description, example })` 필수.
- 요청 DTO → 엔티티 변환은 DTO 메서드(`toCommand()` 등), 엔티티 → 응답 DTO는 정적 메서드(`XxxResponseDto.from(entity)`).
- 응답 DTO에 비밀값(`*_enc`, `key_hash`, 빌링키 원문) 절대 포함 금지.
- 검증 메시지는 한국어. `common/utils/validation-message.util.ts`의 공통 함수 사용 (예: `'amount는 0보다 커야 합니다.'`).
- 선택 필드: `@IsOptional()` + `?`. 숫자 쿼리: `@Type(() => Number)`. uuid 경로 파라미터: `ParseUUIDPipe`.

### 서비스 레이어
- 트랜잭션은 `typeorm-transactional`의 `@Transactional()`.
- 토스 호출은 DB 트랜잭션 **밖에서**. 순서: (tx1) 선기록 → 토스 호출 → (tx2) 결과 반영 + 원장 + outbox.
- 금액이 바뀌는 쓰기는 대상 행을 `pessimistic_write` 락으로 조회.
- 에러는 아래 "에러 처리" 규칙을 따른다. NestJS 내장 예외(`BadRequestException` 등)를 직접 던지지 않는다.

### 에러 처리 (한국어 메시지)

모든 에러는 **영문 에러 코드 + 한국어 메시지**로 내려간다.
코드는 서비스가 분기에 쓰는 안정적인 식별자이고, 메시지는 사람이 읽는 설명이다. **코드는 한 번 공개하면 이름을 바꾸지 않는다.**

- 에러 코드 정의: `common/errors/error-code.ts` ← **에러 코드의 단일 진실 공급원**
- 예외 클래스: `common/errors/business.exception.ts` → `new BusinessException(ErrorCode.X, detail?)`
- 전역 필터: `common/filters/http-exception.filter.ts` → 모든 예외를 아래 형식으로 변환
- 전역 설정(prefix·ValidationPipe·필터)은 `src/app.setup.ts`의 `setupApp()` 하나로 모은다. `main.ts`와 테스트가 같은 함수를 써서 설정이 어긋나지 않게 한다.

```ts
// common/errors/error-code.ts — 정의는 status·message만 쓰고, code(=키)는 자동으로 붙는다
const ERROR_DEFINITIONS = {
  ORDER_NOT_FOUND: { status: 404, message: '주문을 찾을 수 없습니다.' },
  // ...
} as const satisfies Record<string, { status: number; message: string }>;

ErrorCode.ORDER_NOT_FOUND // { code: 'ORDER_NOT_FOUND', status: 404, message: '...' }
```

에러 응답 형식 (`IResponseBase`와 같은 뼈대):

```json
{
  "success": false,
  "code": "CANCEL_AMOUNT_EXCEEDED",
  "message": "환불 가능 금액을 초과했습니다.",
  "detail": { "refundableAmount": 4000 }
}
```

필터의 변환 규칙:
- `BusinessException` → 정의된 status, code, message 그대로
- class-validator 실패 → `400 INVALID_REQUEST`, 필드별 한국어 메시지를 `detail.errors`에 `{ field, message }` 배열로. 중첩 필드는 점 경로(`items.0.quantity`), 정의되지 않은 필드는 `'허용되지 않은 필드입니다.'`
- Nest 내장 예외 → 400은 `INVALID_REQUEST`(JSON 파싱 실패 등), 401은 `UNAUTHORIZED`, 404는 `RESOURCE_NOT_FOUND`(없는 경로). 그 외 status는 `500 INTERNAL_ERROR`로 처리한다. hub 코드에서는 내장 예외를 직접 던지지 않는다
- 토스 에러 → 아는 코드는 hub 코드로 매핑, 모르는 코드는 `PG_ERROR`. 토스 원본 `code`·`message`는 `detail.pgCode`·`detail.pgMessage`로 전달하고 DB `failure_code`/`failure_message`에도 보존 (카드 거절 사유 등을 서비스가 사용자에게 보여줄 수 있게)
- 그 외 예상 못 한 예외 → `500 INTERNAL_ERROR`, 메시지는 `'일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'`. 스택·SQL·내부 정보는 응답에 넣지 않고 로그로만 남긴다
- `detail`에 비밀값·개인정보 금지

기본 에러 코드 (추가 시 `error-code.ts`와 이 표를 함께 갱신):

| 코드 | status | 메시지 |
|------|--------|--------|
| `INVALID_REQUEST` | 400 | 요청 값이 올바르지 않습니다. |
| `UNAUTHORIZED` | 401 | 인증 정보가 없거나 올바르지 않습니다. |
| `API_KEY_EXPIRED` | 401 | 만료된 API 키입니다. |
| `API_KEY_REVOKED` | 401 | 폐기된 API 키입니다. |
| `SERVICE_SUSPENDED` | 403 | 이용이 중지된 서비스입니다. |
| `ADMIN_ACTOR_REQUIRED` | 400 | 관리자 식별 정보(X-Admin-Actor-Id)가 필요합니다. |
| `SERVICE_CODE_DUPLICATED` | 409 | 이미 사용 중인 서비스 코드입니다. |
| `ADMIN_REASON_REQUIRED` | 400 | 이 작업에는 사유 입력이 필요합니다. |
| `RESOURCE_NOT_FOUND` | 404 | 요청한 리소스를 찾을 수 없습니다. (타 서비스 리소스도 404로 응답해 존재 여부를 숨긴다) |
| `PRODUCT_TYPE_NOT_ALLOWED` | 400 | 등록되지 않은 상품 유형입니다. |
| `ORDER_NOT_FOUND` | 404 | 주문을 찾을 수 없습니다. |
| `ORDER_AMOUNT_INVALID` | 400 | 주문 항목 합계와 주문 금액이 일치하지 않습니다. |
| `ORDER_EXPIRED` | 409 | 결제 가능 시간이 지난 주문입니다. |
| `ORDER_ALREADY_PAID` | 409 | 이미 결제된 주문입니다. |
| `ORDER_IDEMPOTENCY_CONFLICT` | 409 | 같은 주문번호로 다른 내용의 주문이 이미 존재합니다. |
| `PAYMENT_NOT_FOUND` | 404 | 결제 내역을 찾을 수 없습니다. |
| `PAYMENT_AMOUNT_MISMATCH` | 400 | 결제 금액이 주문 금액과 일치하지 않습니다. |
| `PAYMENT_IN_PROGRESS` | 409 | 결제가 처리 중입니다. 잠시 후 결과를 확인해주세요. |
| `PAYMENT_NOT_CANCELABLE` | 409 | 취소할 수 없는 결제 상태입니다. |
| `CANCEL_AMOUNT_EXCEEDED` | 400 | 환불 가능 금액을 초과했습니다. |
| `BILLING_KEY_NOT_FOUND` | 404 | 등록된 자동결제 수단을 찾을 수 없습니다. |
| `PG_CREDENTIAL_NOT_FOUND` | 500 | 결제 대행사 설정이 누락되었습니다. 관리자에게 문의해주세요. |
| `PG_TIMEOUT` | 504 | 결제 대행사 응답이 지연되고 있습니다. 결과를 확인 중입니다. |
| `PG_ERROR` | 502 | 결제 대행사에서 오류가 발생했습니다. |
| `INTERNAL_ERROR` | 500 | 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요. |

같은 멱등키로 재요청했을 때 이미 처리된 건은 에러가 아니라 기존 결과를 200으로 반환한다. 내용이 다른 재요청만 `*_IDEMPOTENCY_CONFLICT`.

### 인증
- 서비스 API: `Authorization: Bearer <api_key>` → ApiKeyGuard가 SHA-256 해시로 `tb_service_api_key` 조회 (revoked/expired/서비스 SUSPENDED 거부), `last_used_at` 갱신은 비동기.
- 인증된 서비스 ID는 `req.serviceId`. 모든 조회·쓰기 쿼리에 `service_id` 조건 필수.
- 어드민 API: AdminGuard가 admin 키 + 관리자 헤더 검증 (6장 참고). 인증된 관리자는 `req.adminActor`.
- **가드는 기본 거부(default deny).** 모든 핸들러는 `@ServiceApi()`, `@AdminApi()`, `@Public()` 중 하나를 반드시 붙인다. 아무것도 없으면 전역 가드가 거부한다.
  - 구조: 전역 `AuthGuard`(`common/guards/auth.module.ts`에서 `APP_GUARD` 등록)가 데코레이터를 읽고 `AdminGuard` / `ApiKeyGuard`에 위임한다. 데코레이터는 컨트롤러에도 붙일 수 있고 핸들러가 우선한다.
  - `ADMIN_API_KEY_HASHES`에 SHA-256 hex가 아닌 값이 있으면 부팅을 실패시킨다. 비어 있으면 모든 관리자 요청을 거부한다.
  - 관리자 헤더(`X-Admin-Actor-Id`/`-Name`, `X-Request-Id`)는 감사 로그 컬럼 길이(100자)를 넘으면 `400 INVALID_REQUEST`.
- 서비스 API 키로 `/admin/*`에, admin 키로 서비스 API에 접근할 수 없다. 두 키는 섞이지 않는다.
- 서버 간 통신 전용이므로 CORS는 기본 비활성.

### 컨트롤러 / Swagger
- 모든 핸들러에 `@ApiOperation`, `@ResponseMessage`, `@ApiResponse({ type })`.
- 응답 형식 `IResponseBase<T>`, 목록은 `IPageable<T>` (`{ data, totalCount, nextCursor }`).

### 테스트
- 도메인 엔티티 메서드는 단위 테스트 필수 (상태 전이, 금액 경계값, 잘못된 전이).
- 결제·취소 유스케이스는 멱등 재요청, 동시 요청, 토스 타임아웃, 서비스 소유권 위반 케이스 포함.
- 에러 케이스 테스트는 HTTP status뿐 아니라 **에러 `code`까지** 검증한다.
- 테스트 위치: `/test/<domain>/*.spec.ts`.
- DB가 필요한 통합 테스트는 `*.int-spec.ts` → `npm run test:integration`. 실행마다 `TEST_DB_DATABASE`(기본 `payment_hub_test`, `_test`로 끝나야 함)를 DROP 후 재생성하고 `db/schema.sql`을 적용한다.
- `test/schema/`의 적합성 테스트가 엔티티 ↔ 스키마(테이블·컬럼·타입·길이·nullable·PK·FK)와 constants ↔ CHECK 값을 검증한다. 스키마·엔티티·constants를 바꾸면 반드시 통과시킨다.

---

## 9. 작업 규칙 (Claude에게)

- 사용자가 요청하지 않으면 커밋하지 않는다.
- **커밋할 때마다 `CHANGELOG.md`를 같은 커밋에 함께 갱신한다** (10장 참고).
- 서비스 API에 관리성 쓰기(키 발급, PG 키, 상품 유형, 웹훅 설정, 서비스 상태 변경)를 절대 추가하지 않는다. 필요하면 admin API로 만든다.
- admin API의 모든 쓰기는 같은 트랜잭션에서 `tb_admin_audit_log`를 남긴다. 감사 로그 없는 관리 쓰기는 머지하지 않는다.
- 어떤 응답(admin 포함)에도 API 키 해시, 시크릿 키, 빌링키, 웹훅 서명 키 원문을 넣지 않는다. 평문 반환은 발급 직후 1회뿐이다.
- 스키마 변경이 필요하면 **`db/schema.sql`을 먼저 수정**하고, 엔티티·constants·이 문서를 함께 맞춘다.
- constants의 상태 값은 DB CHECK 제약 값과 1:1로 일치시킨다.
- hub에 특정 서비스 전용 분기·이벤트·필드를 추가하지 않는다. 필요하면 `metadata`나 범용 이벤트로 해결한다.
- 원장 테이블에 UPDATE/DELETE 코드를 작성하지 않는다.
- 로그에 API 키, 시크릿 키, 빌링키, 카드번호 원문을 남기지 않는다.
- 설계 판단이 이 문서의 원칙과 충돌하면 구현 전에 사용자에게 먼저 묻는다.

---

## 10. 변경 이력 관리 (CHANGELOG.md)

작업 히스토리는 **`CHANGELOG.md`에 기록한다.** 이 문서(CLAUDE.md)는 "현재 규칙과 설계"만 담고, "무엇을 언제 왜 바꿨는지"는 CHANGELOG에 쌓는다.
(CLAUDE.md는 매 세션 컨텍스트로 읽히므로 이력이 쌓이면 규칙이 묻힌다.)

### 규칙
- 커밋마다 CHANGELOG.md에 항목을 추가하고, **코드 변경과 같은 커밋에 포함**한다.
- 최신 항목이 위. 날짜별로 묶고, 그 안에 커밋 단위 항목을 쓴다.
- 버전을 태깅하면 `## [Unreleased]`의 내용을 `## [x.y.z] - YYYY-MM-DD`로 옮긴다.
- 설계 원칙·스키마·에러 코드가 바뀐 커밋이면 CLAUDE.md도 같은 커밋에서 갱신하고, CHANGELOG의 "문서" 항목에 그 사실을 적는다.
- 커밋 해시는 커밋 후에야 알 수 있으므로 CHANGELOG에는 적지 않는다. 대신 커밋 제목을 그대로 적어 `git log`로 찾을 수 있게 한다.

### 커밋 메시지
`<type>(<scope>): <한국어 요약>` — type: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `schema`
예: `feat(payment): 결제 승인 API 및 금액 대조 검증 추가`

### 항목 형식

```md
## [Unreleased]

### YYYY-MM-DD

#### feat(payment): 결제 승인 API 및 금액 대조 검증 추가
- **무엇을**: `POST /payments/confirm` 추가. 주문 금액·소유 서비스·만료 검증 후 토스 승인 호출
- **왜**: 클라이언트 금액 변조 방지, 결과 불명 시 UNKNOWN 처리로 기록 누락 방지
- **변경 파일**: `src/payment/...`, `src/common/errors/error-code.ts`
- **스키마/에러 코드**: `PAYMENT_AMOUNT_MISMATCH`, `PAYMENT_IN_PROGRESS` 추가
- **남은 작업 / 주의**: 대사 배치는 다음 커밋에서
```

"왜"는 생략하지 않는다. 나중에 설계 의사결정 기록(ADR) 역할을 한다.
