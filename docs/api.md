# payment-hub API 명세

> 연동 서비스 개발자와 admin 레포 개발자를 위한 API 계약서.
> 설계 원칙과 배경은 [CLAUDE.md](../CLAUDE.md), 스키마는 [db/schema.sql](../db/schema.sql) 참고.
> 구현 상태는 각 API 옆 표시: ✅ 구현됨 · 🚧 예정
> 연동 방법은 가이드부터: [서비스 연동](guides/service-integration.md) · [admin 연동](guides/admin-integration.md) · 클라이언트 생성용 [openapi.json](openapi.json)

## 목차

1. [공통](#1-공통)
2. [관리자 API](#2-관리자-api-apiv1admin) — 서비스·키·PG 자격증명·상품 유형·결제 운영
3. [서비스 API](#3-서비스-api-apiv1) — 주문·결제·환불·조회·빌링키
4. [hub → 서비스 웹훅](#4-hub--서비스-웹훅)
5. [연동 순서 예시](#5-연동-순서-예시)

---

## 1. 공통

### 1.1 호출 주체와 인증

API는 호출 주체에 따라 두 표면으로 완전히 나뉜다. **두 키는 섞이지 않는다** — 서비스 키로 `/admin/*`를, admin 키로 서비스 API를 호출하면 `401`.

| | 서비스 API | 관리자 API |
|---|---|---|
| 경로 | `/api/v1/*` | `/api/v1/admin/*` |
| 호출자 | 각 서비스 서버 (서버 간 통신 전용) | admin 레포 백엔드 (내부망 전용) |
| 데이터 범위 | 자기 서비스 것만 | 전 서비스 |

인증 구현 상태: 관리자 인증(`AdminGuard`) ✅ · 서비스 API 키 인증(`ApiKeyGuard`) ✅

**서비스 API 헤더**

| 헤더 | 필수 | 설명 |
|---|---|---|
| `Authorization` | ✅ | `Bearer ph_live_xxxxxxxx...` — admin이 발급한 서비스 API 키 |

**관리자 API 헤더**

| 헤더 | 필수 | 설명 |
|---|---|---|
| `Authorization` | ✅ | `Bearer <admin_api_key>` — hub는 env `ADMIN_API_KEY_HASHES`(SHA-256 hex, 쉼표 구분)로 검증 |
| `X-Admin-Actor-Id` | ✅ | 작업한 관리자 ID (최대 100자). 감사 로그 `actor_id` |
| `X-Admin-Actor-Name` | | 관리자 이름. URL 인코딩 |
| `X-Request-Id` | | admin 레포 로그와 연결할 추적 ID |

### 1.2 환경 (TEST / LIVE)

**hub 배포 하나가 PG 환경 하나를 담당한다.** 테스트 hub와 운영 hub는 DB까지 분리해 띄우고,
각 hub는 env `PG_ENVIRONMENT`(TEST/LIVE)에 맞는 PG 자격증명만 사용한다. 테스트 결제가 운영 원장·리포트에 섞이지 않게 하기 위함이다.

| 환경 | API 키 prefix | 사용하는 PG 자격증명 |
|---|---|---|
| TEST | `ph_test_` | `environment = 'TEST'` |
| LIVE | `ph_live_` | `environment = 'LIVE'` |

### 1.3 응답 형식

**성공**

```json
{
  "success": true,
  "message": "주문이 등록되었습니다.",
  "data": { }
}
```

**목록** — `data`가 아래 형태. cursor 기반 페이징(`created_at DESC, id DESC`)

```json
{
  "success": true,
  "message": "결제 목록을 조회했습니다.",
  "data": {
    "data": [ ],
    "totalCount": 132,
    "nextCursor": "eyJjcmVhdGVkQXQiOi..."
  }
}
```

| 쿼리 | 설명 |
|---|---|
| `limit` | 기본 20, 최대 100 |
| `cursor` | 이전 응답의 `nextCursor`. 마지막 페이지면 `nextCursor = null` |

**실패** — 영문 `code`로 분기하고, `message`는 사람이 읽는 한국어 설명

```json
{
  "success": false,
  "code": "CANCEL_AMOUNT_EXCEEDED",
  "message": "환불 가능 금액을 초과했습니다.",
  "detail": { "refundableAmount": 4000 }
}
```

- 검증 실패: `400 INVALID_REQUEST`, `detail.errors = [{ "field": "items.0.quantity", "message": "..." }]`
- PG 에러: `detail.pgCode`, `detail.pgMessage`에 토스 원본 코드·메시지 (카드 거절 사유를 사용자에게 보여줄 때 사용)
- 전체 에러 코드: [CLAUDE.md 8장 "기본 에러 코드"](../CLAUDE.md#에러-처리-한국어-메시지)

### 1.4 금액·시간·ID

- **금액은 정수, 통화 최소 단위.** KRW 10,000원 = `10000`, USD $12.34 = `1234`. 소수 금지
- 시간은 ISO 8601 UTC (`2026-09-26T07:15:22.323Z`). 리포트의 날짜 경계만 KST
- ID는 uuid. **다른 서비스의 ID로 조회하면 존재 여부를 숨기기 위해 `404`**

### 1.5 멱등성

같은 요청을 다시 보내도 결과는 한 번만 반영된다. **이미 처리된 건은 에러가 아니라 기존 결과를 200으로** 돌려준다.
키가 같은데 내용이 다르면 `409 *_IDEMPOTENCY_CONFLICT`.

| 요청 | 멱등키 |
|---|---|
| 주문 등록 | `(서비스, externalOrderId)` |
| 결제 승인 | `(서비스, paymentKey)` — hub가 내부 멱등키를 만든다 |
| 빌링 결제 | `(서비스, idempotencyKey)` — 요청 본문 |
| 환불 | `(서비스, idempotencyKey)` — 요청 본문 |

---

## 2. 관리자 API (`/api/v1/admin`)

- **모든 쓰기는 같은 트랜잭션에서 감사 로그(`tb_admin_audit_log`)를 남긴다.** 조회는 남기지 않는다
- 영향이 큰 작업(정지·삭제·수동 환불·PG 자격증명 비활성)은 `reason` 필수 → 없으면 `400 ADMIN_REASON_REQUIRED`
- 비밀값(API 키·시크릿 키·웹훅 서명 키)은 **발급·등록 직후 응답에서 1회만** 평문으로 나가고, 이후 어떤 응답에도 포함되지 않는다

### 2.1 서비스

| 메서드 | 경로 | 설명 | 감사 로그 | 상태 |
|---|---|---|---|---|
| `POST` | `/admin/services` | 서비스 등록 | `SERVICE_CREATED` | ✅ |
| `GET` | `/admin/services` | 서비스 목록 (`status`, `includeDeleted`) | | ✅ |
| `GET` | `/admin/services/:serviceId` | 서비스 상세 (서명 키는 발급 여부만) | | ✅ |
| `PATCH` | `/admin/services/:serviceId` | 이름·웹훅 URL 수정 | `SERVICE_UPDATED` / `WEBHOOK_CONFIG_UPDATED` | ✅ |
| `POST` | `/admin/services/:serviceId/suspend` | 서비스 정지 (`reason` 필수) | `SERVICE_SUSPENDED` | ✅ |
| `POST` | `/admin/services/:serviceId/resume` | 서비스 재개 | `SERVICE_RESUMED` | ✅ |
| `DELETE` | `/admin/services/:serviceId` | 서비스 삭제 (soft delete, `reason` 필수) | `SERVICE_DELETED` | ✅ |
| `POST` | `/admin/services/:serviceId/webhook-secret/rotate` | 웹훅 서명 키 교체 | `WEBHOOK_SECRET_ROTATED` | ✅ |

**정지·재개·키 폐기는 멱등이다.** 이미 그 상태면 200으로 현재 상태를 돌려주고 감사 로그는 남기지 않는다 (admin 레포 재시도가 에러가 되지 않게).

**정지**되면 API 키가 유효해도 서비스 API 전부 `403 SERVICE_SUSPENDED`. **삭제**는 `deleted_at`만 채우고 결제 이력은 보존하며, 이후 서비스 API는 `401`.

#### `POST /admin/services` — 서비스 등록

```json
// 요청
{
  "code": "SVC_A",
  "name": "서비스 A",
  "webhookUrl": "https://svc-a.example.com/webhooks/payment-hub"
}
```

| 필드 | 타입 | 필수 | 규칙 |
|---|---|---|---|
| `code` | string | ✅ | 영문 대문자·숫자·`_`, 최대 20자, 전역 유일 → 중복 시 `409 SERVICE_CODE_DUPLICATED` |
| `name` | string | ✅ | 최대 100자 |
| `webhookUrl` | string | | http(s) URL. **LIVE 배포는 https만**, TEST 배포는 로컬 개발용 `http://localhost…`도 허용. 없으면 웹훅을 보내지 않음 |

```json
// 응답 201 — webhookSecret은 이 응답에서 1회만
{
  "success": true,
  "message": "서비스가 등록되었습니다.",
  "data": {
    "serviceId": "0b6f...",
    "code": "SVC_A",
    "name": "서비스 A",
    "status": "ACTIVE",
    "webhookUrl": "https://svc-a.example.com/webhooks/payment-hub",
    "webhookSecret": "whsec_9f2c...",
    "createdAt": "2026-09-26T07:15:22.323Z"
  }
}
```

#### `POST /admin/services/:serviceId/suspend`

```json
{ "reason": "결제 이상 거래 조사" }
```

### 2.2 서비스 API 키

서비스가 hub를 호출할 때 `Authorization: Bearer <apiKey>` 헤더에 넣는 키. 서비스당 여러 개를 둘 수 있어 무중단 교체가 가능하다.

| 메서드 | 경로 | 설명 | 감사 로그 | 상태 |
|---|---|---|---|---|
| `POST` | `/admin/services/:serviceId/api-keys` | 키 발급 | `API_KEY_ISSUED` | ✅ |
| `GET` | `/admin/services/:serviceId/api-keys` | 키 목록 (prefix·hint·만료·마지막 사용 시각만) | | ✅ |
| `POST` | `/admin/api-keys/:apiKeyId/revoke` | 키 폐기 | `API_KEY_REVOKED` | ✅ |

#### `POST /admin/services/:serviceId/api-keys` — 키 발급

```json
// 요청
{ "label": "prod-server-1", "expiresAt": "2027-09-26T00:00:00.000Z" }
```

```json
// 응답 201 — apiKey 평문은 이 응답에서 1회만. hub는 SHA-256 해시만 저장한다
{
  "success": true,
  "message": "API 키가 발급되었습니다.",
  "data": {
    "apiKeyId": "7c1e...",
    "label": "prod-server-1",
    "apiKey": "ph_live_4Jt9xQ2mV8...",
    "keyPrefix": "ph_live_",
    "keyHint": "a1B9",
    "expiresAt": "2027-09-26T00:00:00.000Z"
  }
}
```

**키 교체 절차**: 새 키 발급 → 서비스에 배포 → 구 키 `lastUsedAt`이 멈췄는지 목록에서 확인 → 구 키 폐기

### 2.3 PG 자격증명 (토스 키)

| 메서드 | 경로 | 설명 | 감사 로그 | 상태 |
|---|---|---|---|---|
| `POST` | `/admin/services/:serviceId/pg-credentials` | 등록 (같은 환경의 기존 활성 키는 같은 트랜잭션에서 비활성) | `PG_CREDENTIAL_REGISTERED` | ✅ |
| `GET` | `/admin/services/:serviceId/pg-credentials` | 목록 (mId·clientKey·hint·환경·활성 여부) | | ✅ |
| `POST` | `/admin/pg-credentials/:pgCredentialId/deactivate` | 비활성 (`reason` 필수) | `PG_CREDENTIAL_DEACTIVATED` | ✅ |

#### `POST /admin/services/:serviceId/pg-credentials`

```json
{
  "environment": "LIVE",
  "merchantId": "tosspayments_mid",
  "clientKey": "live_ck_...",
  "secretKey": "live_sk_..."
}
```

- `secretKey`는 AES-256-GCM으로 암호화해 저장하고, 암호화 키 버전을 `secret_key_id`에 남긴다 (키 교체 대비)
- 시크릿 키는 **어떤 응답에도 반환하지 않는다.** 응답에는 끝 4자리 `secretKeyHint`만
- 키 prefix가 환경과 다르면(`TEST`에 `live_` 키 등) `400 INVALID_REQUEST` — 운영 키가 테스트 설정에 섞이는 실수 방지
- 교체로 자동 비활성된 이전 키는 새 키의 등록 감사 로그 `before`에 남는다 (사유 입력 불필요)

### 2.4 상품 유형

hub는 개별 상품(이름·가격)을 모른다. 서비스가 파는 **상품 유형**(`PLAN`, `CREDIT`, `ADDON` ...)만 화이트리스트로 등록하고,
주문 항목의 `productType`이 여기 없거나 비활성이면 `400 PRODUCT_TYPE_NOT_ALLOWED`.

| 메서드 | 경로 | 설명 | 감사 로그 | 상태 |
|---|---|---|---|---|
| `POST` | `/admin/services/:serviceId/product-types` | 등록 | `PRODUCT_TYPE_CREATED` | ✅ |
| `GET` | `/admin/services/:serviceId/product-types` | 목록 (`isActive` 필터) | | ✅ |
| `PATCH` | `/admin/services/:serviceId/product-types/:code` | 이름 수정, 중지(`isActive: false`), 재개(`isActive: true`) | `PRODUCT_TYPE_UPDATED` | ✅ |

- **삭제 API는 없다.** 기존 주문 항목이 FK로 참조하므로 `isActive: false`로 중지한다. 중지된 유형은 새 주문에만 쓸 수 없고 기존 결제·환불에는 영향 없음
- 같은 서비스에 같은 코드를 다시 등록하면 `409 PRODUCT_TYPE_DUPLICATED` (다른 서비스는 같은 코드 사용 가능)
- 감사 로그 `target_id`는 복합 PK라 `"<serviceId>:<code>"` 형식

```json
// POST 요청
{ "code": "PLAN", "name": "구독 요금제" }

// PATCH 요청 — 중지
{ "isActive": false }
```

### 2.5 결제 조회·운영

| 메서드 | 경로 | 설명 | 감사 로그 | 상태 |
|---|---|---|---|---|
| `GET` | `/admin/payments` | 전 서비스 결제 검색 | | ✅ |
| `GET` | `/admin/payments/:paymentId` | 결제 상세 — 주문·항목, 취소 이력, 원장 분개, 웹훅 전달 내역, PG 응답 원본 | | ✅ |
| `POST` | `/admin/payments/:paymentId/cancel` | 수동 환불 (`reason` 필수, `requested_by = ADMIN`) | `PAYMENT_CANCELED_BY_ADMIN` | ✅ |
| `GET` | `/admin/ops/unknown-payments` | 대사 대기 결제 (`IN_PROGRESS`·`UNKNOWN` 오래된 순, `serviceId`·`limit`) | | ✅ |
| `POST` | `/admin/ops/payments/:paymentId/reconcile` | 수동 대사 (토스 조회로 지금 확정). 응답 `{ resolved, payment }`. 확정했을 때만 감사 로그 | `PAYMENT_RECONCILED` | ✅ |
| `GET` | `/admin/ops/webhook-deliveries` | 웹훅 전달 내역 (`status=DEAD` 등, `serviceId`, 최신순 cursor) | | ✅ |
| `POST` | `/admin/ops/webhook-deliveries/:deliveryId/redeliver` | 재전송 (`PENDING`으로, **서비스의 현재 webhookUrl로**, `attemptCount` 유지). 이미 대기·전송 중이면 200·감사 로그 없음. webhookUrl이 없으면 `400` | `WEBHOOK_REDELIVERED` | ✅ |
| `GET` | `/admin/ops/pg-webhooks` | 토스 웹훅 수신 내역 (`status=FAILED` 등, `eventType`, 최신순 cursor, 토스 원본 본문 포함) | | ✅ |
| `GET` | `/admin/reports/revenue` | 매출·환불 집계 (`from`·`to` KST 날짜, `groupBy=day|month`, `serviceId`). 응답 `{ rows: [{ serviceId, period, currency, revenue, refund, net, paymentCount, cancelCount }], totals }`. 원장 기준, 기간 최대 366일. 결제 수단별 집계는 아직 없음 | | ✅ |
| `GET` | `/admin/audit-logs` | 감사 로그 (`actorId`·`action`·`targetType`+`targetId`·`serviceId`·`from`·`to`, 최신순 cursor). 조회는 기록하지 않음 | | ✅ |

**`GET /admin/payments` 필터**: `serviceId`, `status`(쉼표로 여러 개), `methodType`, `cardCompanyCode`, `from`, `to`, `externalUserId`, `externalOrderId`, `externalSubscriptionId`, `paymentKey`(토스), `limit`, `cursor`. 항목은 서비스 결제 응답 + `serviceId`·`providerPaymentKey`

**`POST /admin/payments/:paymentId/cancel`**: 본문은 서비스 환불(3.4)과 같고 `reason`(필수, 최대 200자)이 추가된다. `idempotencyKey`는 최대 90자이며 서비스의 환불 멱등키와 섞이지 않는다. 사유가 없으면 토스 호출 전에 `400 ADMIN_REASON_REQUIRED`(취소도 기록되지 않음). 사유는 `reasonDetail`이 없으면 토스 취소 사유로도 쓰인다. 감사 로그는 취소 요청을 기록하는 트랜잭션에서 남고, 결과(성공·거절·결과 불명)와 응답 형식은 서비스 환불과 같다 (`payment`는 관리자 형식)

**`GET /admin/payments/:paymentId`**: 결제 + `order`(항목 포함) + `cancels` + `ledger`(`[{ transactionType, referenceType, occurredAt, entries: [{ accountCode, direction, amount }] }]`, 사건 순) + `webhookDeliveries`(`webhookDeliveryId`, `eventId`, `eventType`, `status`, `attemptCount`, `lastHttpStatus`, `lastError`, `deliveredAt`, `targetUrl`) + `providerResponse`(PG 응답 원본 — **관리자에게만**). 조회는 감사 로그를 남기지 않는다

---

## 3. 서비스 API (`/api/v1`)

모든 조회·쓰기는 API 키의 서비스로 범위가 고정된다. 다른 서비스의 리소스는 `404`.

### 3.0 연결 확인

| 메서드 | 경로 | 설명 | 상태 |
|---|---|---|---|
| `GET` | `/me` | API 키가 어느 서비스로 인증되는지 확인. 키 교체 후 배포 검증용 | ✅ |

```json
// 응답 200
{
  "success": true,
  "message": "서비스 정보를 조회했습니다.",
  "data": { "serviceId": "0b6f...", "code": "SVC_A", "name": "서비스 A", "status": "ACTIVE" }
}
```

| 상황 | 응답 |
|---|---|
| 키 없음 / 등록되지 않은 키 / 삭제된 서비스의 키 | `401 UNAUTHORIZED` |
| 폐기된 키 | `401 API_KEY_REVOKED` |
| 만료된 키 | `401 API_KEY_EXPIRED` |
| 정지된 서비스 | `403 SERVICE_SUSPENDED` |

인증에 성공하면 키의 `lastUsedAt`이 비동기로 갱신된다.

### 3.1 PG 설정

| 메서드 | 경로 | 설명 | 상태 |
|---|---|---|---|
| `GET` | `/pg/client-config` | 결제창을 띄울 때 필요한 공개 값 (`clientKey`, `environment`) | ✅ |

서비스 프론트는 이 `clientKey`로 토스 결제창을 띄운다. 시크릿 키는 hub만 가진다.

```json
// 응답 200
{ "success": true, "message": "PG 설정을 조회했습니다.", "data": { "provider": "TOSS", "environment": "LIVE", "clientKey": "live_ck_..." } }
```

이 hub 배포 환경(`PG_ENVIRONMENT`)의 활성 자격증명이 없으면 `500 PG_CREDENTIAL_NOT_FOUND` — 관리자가 PG 자격증명을 등록해야 한다.

### 3.2 주문

결제 전에 **서비스 서버가 주문을 먼저 등록**한다. 금액은 이때 고정되고, 결제 승인 시 이 금액과 대조해 클라이언트 금액 변조를 막는다.

| 메서드 | 경로 | 설명 | 상태 |
|---|---|---|---|
| `POST` | `/orders` | 주문 등록 (새로 만들면 `201`, 같은 요청 재시도면 `200`) | ✅ |
| `GET` | `/orders/:orderId` | 주문 단건 (항목 포함. 결제 정보는 결제 API 구현 시 추가) | ✅ |
| `GET` | `/orders` | 주문 목록 — 항목 없는 요약 (`externalOrderId`, `externalUserId`, `externalSubscriptionId`, `status`, `from`, `to`, `limit`, `cursor`) | ✅ |

#### `POST /orders` — 주문 등록

```json
{
  "externalOrderId": "svc-a-order-20260926-0001",
  "externalUserId": "user-123",
  "externalSubscriptionId": "sub-77",
  "orderName": "프로 요금제 1개월 외 1건",
  "currency": "KRW",
  "items": [
    { "productType": "PLAN", "externalProductId": "pro-monthly", "productName": "프로 요금제 1개월", "unitPrice": 29000, "quantity": 1 },
    { "productType": "ADDON", "externalProductId": "storage-10g", "productName": "추가 저장공간 10GB", "unitPrice": 3000, "quantity": 2 }
  ],
  "discountType": "COUPON_WELCOME",
  "discountAmount": 5000,
  "totalAmount": 30000,
  "expiresInSeconds": 1800,
  "metadata": { "plan": "pro" }
}
```

| 필드 | 타입 | 필수 | 규칙 |
|---|---|---|---|
| `externalOrderId` | string | ✅ | 최대 100자. `(서비스, externalOrderId)`가 멱등키 |
| `externalUserId` | string | ✅ | 최대 100자 |
| `externalSubscriptionId` | string | | 최대 100자. 정기결제 체인 조회용 |
| `orderName` | string | ✅ | 최대 100자. 토스 결제창 표시 |
| `currency` | string | | ISO 4217 대문자 3자리. 기본 `KRW` |
| `items` | array | ✅ | 1~100개 |
| `items[].productType` | string | ✅ | 활성 상품 유형 코드 |
| `items[].externalProductId` / `productName` | string | ✅ | 최대 100자 |
| `items[].unitPrice` | integer | ✅ | 0 이상, 통화 최소 단위 |
| `items[].quantity` | integer | ✅ | 1 이상 |
| `discountType` | string | | 최대 50자. 저장만 |
| `discountAmount` | integer | | 0 이상. 기본 0 |
| `totalAmount` | integer | ✅ | 1 이상 |
| `expiresInSeconds` | integer | | 60 ~ 604800(7일). 기본 1800 |
| `metadata` | object | | 서비스 맥락. 저장만 |

| 검증 | 실패 시 |
|---|---|
| `sum(unitPrice × quantity) − discountAmount = totalAmount`, 할인 ≤ 원금 | `400 ORDER_AMOUNT_INVALID` + `detail { originalAmount, discountAmount, expectedTotalAmount, totalAmount }` |
| `productType`이 등록된 **활성** 상품 유형 | `400 PRODUCT_TYPE_NOT_ALLOWED` + `detail { productTypes: ["NOPE", ...] }` |
| 같은 `externalOrderId`로 내용이 다른 주문 존재 | `409 ORDER_IDEMPOTENCY_CONFLICT` |

**멱등**: 같은 `externalOrderId`로 **같은 내용**(사용자·구독·주문명·통화·항목·할인·금액·metadata)을 다시 보내면 기존 주문을 `200`으로 돌려준다. `expiresInSeconds`는 비교하지 않는다(재시도마다 만료가 늘어나지 않음). 동시에 여러 번 보내도 주문은 하나만 생긴다.

- 할인·금액 계산은 서비스 책임. hub는 합계가 맞는지만 확인하고, `discountType`·`metadata`는 해석 없이 저장한다
- 응답의 `orderId`를 토스 결제창의 `orderId`로 사용한다
- `expiresInSeconds` 이후에는 결제 승인이 `409 ORDER_EXPIRED`
- 만료 배치 ✅(1분마다)가 결제 없이 만료된 주문을 `EXPIRED`로 바꾸고 `ORDER_EXPIRED` 웹훅을 보낸다. **입금 대기(가상계좌)·결과 불명 결제가 있는 주문은 만료하지 않는다** — 결제가 확정되면 그 결과를 따른다

```json
// 응답 201 (재시도는 200, 본문 동일)
{
  "success": true,
  "message": "주문이 등록되었습니다.",
  "data": {
    "orderId": "3f1a8c2e-...",
    "externalOrderId": "svc-a-order-20260926-0001",
    "externalUserId": "user-123",
    "externalSubscriptionId": "sub-77",
    "orderName": "프로 요금제 1개월 외 1건",
    "currency": "KRW",
    "originalAmount": 35000,
    "discountType": "COUPON_WELCOME",
    "discountAmount": 5000,
    "totalAmount": 30000,
    "status": "PENDING",
    "expiresAt": "2026-09-27T01:30:00.000Z",
    "paidAt": null,
    "metadata": { "plan": "pro" },
    "createdAt": "2026-09-27T01:00:00.000Z",
    "items": [
      { "orderItemId": "c1...", "lineNo": 1, "productType": "PLAN", "externalProductId": "pro-monthly", "productName": "프로 요금제 1개월", "unitPrice": 29000, "quantity": 1, "amount": 29000, "canceledQuantity": 0 },
      { "orderItemId": "c2...", "lineNo": 2, "productType": "ADDON", "externalProductId": "storage-10g", "productName": "추가 저장공간 10GB", "unitPrice": 3000, "quantity": 2, "amount": 6000, "canceledQuantity": 0 }
    ]
  }
}
```

`GET /orders/:orderId`는 위 `data`와 같은 형태. 다른 서비스의 주문 ID면 `404 ORDER_NOT_FOUND`.

### 3.3 결제

| 메서드 | 경로 | 설명 | 상태 |
|---|---|---|---|
| `POST` | `/payments/confirm` | 일반 결제 승인 (결제창 인증 후) | ✅ |
| `POST` | `/payments/billing` | 빌링키 자동결제 | ✅ |
| `GET` | `/payments/:paymentId` | 결제 단건 — 수단 분류, 환불 가능 금액, 실패 사유, 취소 이력(`cancels`) | ✅ |
| `GET` | `/payments` | 결제 목록 — **사용자별 조회** | ✅ |
| `GET` | `/payments/:paymentId/refundable` | 환불 가능 금액·항목별 취소 가능 수량 | ✅ |

#### `POST /payments/confirm` — 결제 승인

토스 결제창 `successUrl`로 받은 세 값을 그대로 보낸다.

```json
{
  "orderId": "3f1a...",
  "paymentKey": "tgen_20260926...",
  "amount": 30000
}
```

| 필드 | 타입 | 필수 | 규칙 |
|---|---|---|---|
| `orderId` | uuid | ✅ | hub 주문 ID (결제창에 넘긴 값) |
| `paymentKey` | string | ✅ | 최대 200자 |
| `amount` | integer | ✅ | 1 이상. 주문 `totalAmount`와 같아야 한다 |

처리 순서: 주문 행 락 → 검증 → 결제를 `IN_PROGRESS`로 먼저 저장 → 토스 승인 호출(트랜잭션 밖) → 결과 반영 + 원장 기장 + 웹훅 이벤트 기록(한 트랜잭션).
같은 주문의 승인 요청은 주문 행 락으로 직렬화되므로 동시에 여러 번 보내도 토스 승인은 한 번이다.

**결과별 응답** — 서비스는 `code`로 분기한다.

| 상황 | 응답 | 결제 상태 | 서비스가 할 일 |
|---|---|---|---|
| 승인 | `200` | `DONE` | 완료 처리 (후속 작업은 웹훅 `PAYMENT_CONFIRMED`로 해도 된다) |
| 가상계좌 발급 | `200` | `WAITING_FOR_DEPOSIT` | 사용자에게 `method.virtualAccountNumber`·`virtualAccountDueAt` 안내. 입금되면 `PAYMENT_CONFIRMED` 웹훅 |
| 같은 `paymentKey` 재요청 | 처음과 같은 결과 (`200` 또는 같은 에러) | 그대로 | 토스를 다시 부르지 않는다 |
| 주문이 이 서비스 것이 아님 | `404 ORDER_NOT_FOUND` | 기록 안 함 | |
| 주문 만료 | `409 ORDER_EXPIRED` | 기록 안 함 | 새 주문 등록 |
| 이미 결제된 주문 | `409 ORDER_ALREADY_PAID` | 기록 안 함 | |
| `amount ≠ totalAmount` | `400 PAYMENT_AMOUNT_MISMATCH` | 기록 안 함 | 금액 변조 의심 |
| 토스 자격증명 미등록 | `500 PG_CREDENTIAL_NOT_FOUND` | 기록 안 함 | admin에 문의 |
| **토스 거절** (한도 초과 등) | `402 PAYMENT_REJECTED` + `detail.pgCode`·`pgMessage` | `FAILED` | `pgMessage`를 사용자에게 보여주고 **다른 결제창(새 paymentKey)으로 재시도**. 실패한 시도는 주문을 막지 않는다 |
| 토스 키 인증 실패 (hub 설정 문제) | `502 PG_ERROR` + `detail.pgCode` | `FAILED` | admin에 문의 |
| **토스 응답 지연·연결 실패** | `504 PG_TIMEOUT` | `UNKNOWN` | **재시도하지 말고** 결과 조회·웹훅을 기다린다 (대사 배치가 확정 ✅) |
| **토스 5xx·이미 처리됨** | `502 PG_ERROR` | `UNKNOWN` | 위와 같음 |
| 이 주문에 처리 중인 결제가 있음 | `409 PAYMENT_IN_PROGRESS` + `detail.paymentId` | 그대로 | 위와 같음 |

**대사 배치 ✅**: 1분마다 `IN_PROGRESS`·`UNKNOWN` 중 2분 이상 지난 결제를 토스 조회 API로 확정한다. 토스 `DONE` → `DONE`(원장·`PAYMENT_CONFIRMED`), `ABORTED` → `FAILED`(토스 사유), `EXPIRED` → `EXPIRED`(둘 다 `PAYMENT_FAILED`). 토스도 승인 전이거나 조회가 실패하면 그대로 두고 다음 대사에서 다시 본다. 토스 응답이 결제 기록(paymentKey·orderId·금액)과 다르면 믿지 않고 `UNKNOWN`으로 남긴다.

결제가 기록된 에러(`402`, `502`, `504`, `409 PAYMENT_IN_PROGRESS`)는 `detail.paymentId`(와 `paymentStatus`)를 준다. 이 ID로 `GET /payments/:paymentId`를 조회하면 된다.

```json
// 402 — 토스 거절
{
  "success": false,
  "code": "PAYMENT_REJECTED",
  "message": "결제 대행사가 결제를 승인하지 않았습니다.",
  "detail": {
    "paymentId": "b3c4...",
    "paymentStatus": "FAILED",
    "pgCode": "REJECT_CARD_PAYMENT",
    "pgMessage": "한도초과 혹은 잔액부족으로 결제에 실패했습니다."
  }
}
```

> hub는 토스 응답을 최대 `TOSS_API_TIMEOUT_MS`(기본 30초) 기다린다. **서비스의 confirm 호출 타임아웃은 이보다 길게**(예: 60초) 둔다.
> 그래도 서비스 쪽에서 타임아웃이 나면 결과를 모르는 것이므로 `GET /payments?externalOrderId=`로 확인한다.

```json
// 응답 200 — 카드 결제 (결제 단건·목록 항목도 같은 형태)
{
  "success": true,
  "message": "결제가 승인되었습니다.",
  "data": {
    "paymentId": "a9d2...",
    "orderId": "3f1a...",
    "externalOrderId": "svc-a-order-20260926-0001",
    "externalUserId": "user-123",
    "orderName": "프로 요금제 1개월",
    "paymentType": "NORMAL",
    "status": "DONE",
    "amount": 30000,
    "refundedAmount": 0,
    "refundableAmount": 30000,
    "currency": "KRW",
    "method": {
      "type": "CARD",
      "raw": "카드",
      "cardCompanyCode": "11",
      "cardType": "CREDIT",
      "cardNumberMasked": "433012******123*",
      "installmentMonths": 0,
      "easyPayProvider": null,
      "bankCode": null,
      "virtualAccountNumber": null,
      "virtualAccountDueAt": null
    },
    "receiptUrl": "https://dashboard.tosspayments.com/receipt/...",
    "approvedAt": "2026-09-26T07:16:03.000Z",
    "failure": null,
    "createdAt": "2026-09-26T07:15:58.000Z"
  }
}
```

가상계좌는 `status: "WAITING_FOR_DEPOSIT"`, `approvedAt: null`과 함께 입금 안내 정보를 준다. 입금되면 `PAYMENT_CONFIRMED` 웹훅이 온다 (토스 입금 웹훅 수신 ✅ — 4-1장). 입금 기한까지 입금이 없으면 `EXPIRED` + `PAYMENT_FAILED`.

```json
"method": {
  "type": "VIRTUAL_ACCOUNT",
  "raw": "가상계좌",
  "bankCode": "20",
  "virtualAccountNumber": "X6505636518308",
  "virtualAccountDueAt": "2026-09-27T14:59:59.000Z",
  "...": "그 외 필드는 null"
}
```

**`method.type` 값**: `CARD`, `VIRTUAL_ACCOUNT`, `TRANSFER`, `EASY_PAY`, `MOBILE_PHONE`, `GIFT_CERTIFICATE` (토스가 새 수단을 주면 `null`, 원문은 `raw`)
**`method.cardType` 값**: `CREDIT`, `CHECK`, `GIFT`, `UNKNOWN`
카드사(`cardCompanyCode`)·은행(`bankCode`) 코드와 `easyPayProvider`는 토스 코드 원문이다. 간편결제를 카드로 했으면 카드 필드도 채워진다.
실패한 결제는 `failure: { "code": "REJECT_CARD_PAYMENT", "message": "..." }`.

#### `POST /payments/billing` — 자동결제

서비스 배치가 결제 대상·재시도 정책을 판단한 뒤, 주문을 등록하고 호출한다.

```json
{
  "orderId": "5b7c...",
  "billingKeyId": "e21f...",
  "amount": 29000,
  "idempotencyKey": "svc-a-billing-sub-77-2026-10"
}
```

| 필드 | 타입 | 필수 | 규칙 |
|---|---|---|---|
| `orderId` | uuid | ✅ | 미리 등록한 주문 |
| `billingKeyId` | uuid | ✅ | 주문의 사용자와 **같은 사용자**의 활성 수단 |
| `amount` | integer | ✅ | 주문 결제 금액과 같아야 한다 |
| `idempotencyKey` | string | ✅ | 최대 90자. `(서비스, idempotencyKey)`가 멱등키 — 재시도에도 같은 값 (예: `구독ID-회차`) |

- 빌링키가 이 서비스·같은 사용자 것이 아니거나 해제되었으면 `404 BILLING_KEY_NOT_FOUND` (토스 호출 없음)
- 같은 `idempotencyKey`·같은 내용(주문·빌링키·금액) → 기록된 결과, 다른 내용 → `409 PAYMENT_IDEMPOTENCY_CONFLICT`
- 이후 검증·결과·에러(`402 PAYMENT_REJECTED`, `504 PG_TIMEOUT` …)와 응답(`paymentType: "BILLING"`)은 결제 승인과 같다
- 카드 거절 후 재시도는 **새 idempotencyKey**로 (실패한 시도는 주문을 막지 않는다)
- 결과 불명(`UNKNOWN`)이면 대사가 토스 **주문번호 조회**로 확정한다 (자동결제는 응답 전에는 paymentKey가 없음)

#### `GET /payments` — 결제 목록 (사용자별)

자기 서비스 결제만, 최신순(`createdAt`, `id`) cursor 페이징. **실패한 시도도 포함**한다.

| 쿼리 | 설명 |
|---|---|
| `externalUserId` | 사용자 ID. **서비스 + 사용자 단위 결제 이력** |
| `externalOrderId` | 서비스 주문번호 (confirm 타임아웃 후 결과 확인에도 사용) |
| `externalSubscriptionId` | 구독 결제 체인 (일할 환불 계산용) |
| `status` | `DONE,PARTIAL_CANCELED`처럼 쉼표로 여러 개. 모르는 값이면 `400 INVALID_REQUEST` |
| `methodType` | `CARD`, `VIRTUAL_ACCOUNT`, ... |
| `from`, `to` | 결제 시도 시각 범위 (ISO 8601, `from` 이상 `to` 미만) |
| `limit`, `cursor` | 페이지 크기(1~100, 기본 20), 이전 응답의 `nextCursor` |

응답 `data`는 `{ data: [결제...], totalCount, nextCursor }`. 결제 항목은 승인 응답과 같은 형태다.
서비스 응답에서는 PG 응답 원본, 원장 분개, 대사 내부 정보를 **제외**한다.

#### `GET /payments/:paymentId/refundable` — 환불 가능 금액

환불 요청 `amount`의 상한과 항목별 취소 가능 수량. 승인되지 않은 결제(`IN_PROGRESS`, `UNKNOWN`, `WAITING_FOR_DEPOSIT`, `FAILED` ...)는 금액·수량 모두 `0`.
다른 서비스의 결제는 `404 PAYMENT_NOT_FOUND`.

```json
{
  "success": true,
  "message": "환불 가능 금액을 조회했습니다.",
  "data": {
    "paymentId": "a9d2...",
    "status": "PARTIAL_CANCELED",
    "amount": 30000,
    "refundedAmount": 3000,
    "refundableAmount": 27000,
    "items": [
      { "orderItemId": "c1...", "productName": "프로 요금제 1개월", "unitPrice": 24000, "quantity": 1, "canceledQuantity": 0, "cancelableQuantity": 1 },
      { "orderItemId": "c2...", "productName": "추가 저장공간 10GB", "unitPrice": 3000, "quantity": 2, "canceledQuantity": 1, "cancelableQuantity": 1 }
    ]
  }
}
```

### 3.4 환불

| 메서드 | 경로 | 설명 | 상태 |
|---|---|---|---|
| `POST` | `/payments/:paymentId/cancel` | 전체·부분 환불 | ✅ |

```json
{
  "amount": 3000,
  "reasonCode": "USER_REQUEST",
  "reasonDetail": "추가 저장공간 1개 환불",
  "idempotencyKey": "svc-a-refund-0001",
  "items": [ { "orderItemId": "c2...", "quantity": 1, "amount": 3000 } ],
  "refundReceiveAccount": { "bankCode": "20", "accountNumber": "1002123456789", "holderName": "홍길동" }
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `amount` | ✅ | 환불 금액(1 이상). **금액 계산(일할 등)은 서비스 책임**, 상한은 환불 가능 금액 |
| `reasonCode` | ✅ | 서비스 정의 값(최대 50자). hub는 저장만 |
| `reasonDetail` | | 최대 200자. 토스 취소 사유로 전달 (없으면 `reasonCode`) |
| `idempotencyKey` | ✅ | 최대 100자. `(서비스, idempotencyKey)`가 멱등키 |
| `items` | | 항목별 취소 기록 (부분 환불 추적용). 주면 **항목 금액 합계 = `amount`** |
| `refundReceiveAccount` | 가상계좌만 ✅ | 환불받을 계좌(`bankCode` 숫자 2~3자리, `accountNumber` 숫자 6~20자리, `holderName`). 토스에 전달만 하고 **hub는 저장하지 않는다** |

처리 순서: 결제 행 락 → 검증 → 취소 `REQUESTED` 선기록 → 토스 취소(트랜잭션 밖, 취소 건 단위 멱등키) → 결과 반영 + 결제·주문·항목 취소 수량 + 원장 반대 분개(차 REFUND / 대 PG_RECEIVABLE) + `PAYMENT_CANCELED` 웹훅 이벤트(한 트랜잭션).

| 상황 | 응답 | 취소 상태 | 서비스가 할 일 |
|---|---|---|---|
| 환불 완료 | `200` | `DONE` | 완료 처리. 결제는 전액이면 `CANCELED`, 일부면 `PARTIAL_CANCELED` |
| 같은 `idempotencyKey`·같은 내용 재요청 | 처음과 같은 결과 | 그대로 | 토스를 다시 부르지 않는다 |
| 같은 키·다른 내용 (금액·사유 코드·항목) | `409 CANCEL_IDEMPOTENCY_CONFLICT` | | 키 생성 로직 확인 |
| 다른 서비스의 결제 | `404 PAYMENT_NOT_FOUND` | 기록 안 함 | |
| 취소할 수 없는 상태 (`DONE`·`PARTIAL_CANCELED` 외) | `409 PAYMENT_NOT_CANCELABLE` | 기록 안 함 | |
| 환불 가능 금액 초과 | `400 CANCEL_AMOUNT_EXCEEDED` + `detail.refundableAmount` | 기록 안 함 | 금액 재계산 |
| 항목 오류 (다른 주문 항목, 중복, 취소 가능 수량 초과, 합계 불일치) | `400 INVALID_REQUEST` + `detail.errors` | 기록 안 함 | |
| 가상계좌인데 환불 계좌 없음 | `400 INVALID_REQUEST` (`refundReceiveAccount`) | 기록 안 함 | |
| **토스 거절** (취소 불가 금액 등) | `409 CANCEL_REJECTED` + `detail.pgCode`·`pgMessage` | `FAILED` | 사유 확인. 새 `idempotencyKey`로 다시 요청 가능 (실패한 취소는 금액을 잡아두지 않음) |
| **토스 응답 지연·연결 실패** | `504 PG_TIMEOUT` + `detail.paymentCancelId` | `UNKNOWN` | 같은 `idempotencyKey`로 재요청하면 `409 CANCEL_IN_PROGRESS`. 결과는 `GET /payments/:id`의 `cancels`로 확인 |
| 토스 5xx·이미 취소됨 | `502 PG_ERROR` | `UNKNOWN` | 위와 같음 |

- **환불 가능 금액 = 결제 금액 − 환불 완료 − 처리 중(`REQUESTED`·`UNKNOWN`) 환불.** 동시에 들어온 부분 환불도 결제 행 락으로 직렬화되어 합계가 결제 금액을 넘지 않는다
- **환불 대사 ✅**: 1분마다 2분 이상 지난 `REQUESTED`·`UNKNOWN` 환불을 **같은 멱등키로 토스에 다시 보낸다.** 토스가 처리했으면 원래 결과를, 처음 요청이 도달하지 않았으면 지금 처리한 결과를 준다 → 요청된 환불이 한 번만 반영된다. 확정 전까지 그 금액은 환불 가능 금액에서 빠져 있다
- 가상계좌 환불 계좌는 저장하지 않으므로, 토스에 도달하지 못한 가상계좌 환불은 대사에서 거절(`FAILED`)되어 금액이 풀린다 → 서비스가 계좌를 넣어 다시 요청한다

```json
// 응답 200
{
  "success": true,
  "message": "환불이 완료되었습니다.",
  "data": {
    "cancel": {
      "paymentCancelId": "d7e8...",
      "status": "DONE",
      "amount": 3000,
      "reasonCode": "USER_REQUEST",
      "reasonDetail": "추가 저장공간 1개 환불",
      "requestedBy": "SERVICE",
      "items": [ { "orderItemId": "c2...", "quantity": 1, "amount": 3000 } ],
      "failure": null,
      "canceledAt": "2026-09-28T00:00:00.000Z",
      "createdAt": "2026-09-28T00:00:00.000Z"
    },
    "payment": { "paymentId": "a9d2...", "status": "PARTIAL_CANCELED", "refundedAmount": 3000, "refundableAmount": 27000, "...": "결제 응답과 같은 형태" }
  }
}
```

`GET /payments/:paymentId`는 결제에 `cancels`(위 `cancel` 형태, 오래된 순)를 붙여 준다.

### 3.5 결제 수단 (빌링키)

사용자 카드를 등록해 두고 자동결제에 쓰는 수단. 카드번호는 마스킹된 값만 저장하고 빌링키는 암호화한다.

| 메서드 | 경로 | 설명 | 상태 |
|---|---|---|---|
| `POST` | `/billing-keys` | 빌링키 발급 (토스 카드 등록창 인증 후) — `201` | ✅ |
| `GET` | `/billing-keys` | 사용자 활성 수단 목록 (`externalUserId` 필수, 최근 등록 순) | ✅ |
| `DELETE` | `/billing-keys/:billingKeyId` | 등록 해제 (hub에서 `REVOKED` — 이후 자동결제 불가. 멱등) | ✅ |

```json
// POST 요청 — customerKey는 서비스가 사용자별로 만든 추측 불가능한 값
{ "externalUserId": "user-123", "customerKey": "c_8f2a...", "authKey": "bln_..." }

// 응답 data
{
  "billingKeyId": "e21f...",
  "externalUserId": "user-123",
  "cardCompany": "신한",
  "cardNumberMasked": "4330-12**-****-123*",
  "status": "ACTIVE",
  "createdAt": "2026-09-26T07:20:00.000Z"
}
```

빌링키 원문은 **어떤 응답에도 나가지 않는다.** 서비스는 `billingKeyId`로만 자동결제를 요청한다.

- `customerKey`: 영문·숫자·`-_=.@` 2~300자 (토스 규칙). 카드 등록창에 넘긴 값과 같아야 한다
- 토스 거절(카드 오류 등) → `402 BILLING_KEY_REJECTED` + `detail.pgCode`·`pgMessage`
- 응답 지연 → `504 PG_TIMEOUT` — 등록 여부를 알 수 없고 authKey는 1회용이므로 **사용자가 카드 등록을 다시 한다** (저장된 것이 없음)
- 해제는 hub 안에서만 이뤄진다 (토스 빌링키 삭제 API는 호출하지 않음). hub에 빌링키가 남지 않으므로 이 키로는 더 이상 결제되지 않는다

### 3.6 이벤트 재조회

| 메서드 | 경로 | 설명 | 상태 |
|---|---|---|---|
| `GET` | `/events?after=<eventId>&limit=` | 웹훅을 놓쳤을 때 발행 순서대로 따라잡기 | ✅ |

- `after`: 마지막으로 처리한 `eventId` (없으면 처음부터). 다른 서비스의 eventId면 `404 RESOURCE_NOT_FOUND`
- `limit`: 1~500, 기본 100
- 응답 `{ data: [{ eventId, eventType, occurredAt, data }], totalCount, nextCursor }` — 항목은 **웹훅 본문과 같은 형태**, `totalCount`는 after 이후 남은 수, `nextCursor`는 다음 조회의 `after` (더 없으면 `null`)
- **발행 직후(기본 5초) 이벤트는 다음 조회에서 나온다.** 먼저 발행됐지만 늦게 커밋되는 이벤트를 건너뛰지 않기 위해서다. 웹훅과 겹쳐 받을 수 있으므로 `eventId`로 중복을 거른다
- 모든 이벤트의 `occurredAt`은 hub 발행 시각이다. 토스 취소 시각은 `PAYMENT_CANCELED`의 `data.cancel.canceledAt`

---

## 4. hub → 서비스 웹훅

결제 상태가 바뀌면 hub가 서비스의 `webhookUrl`로 `POST`한다. 결제 응답과 별개로 **비동기**로 전달된다.

### 요청

| 헤더 | 설명 |
|---|---|
| `X-PaymentHub-Event-Id` | 이벤트 ID. **서비스는 이 값으로 멱등 처리** (같은 이벤트가 여러 번 올 수 있음) |
| `X-PaymentHub-Timestamp` | 전송 시각 (Unix 초) |
| `X-PaymentHub-Signature` | `v1=<hex>` — `HMAC-SHA256(webhookSecret, "<timestamp>.<body>")` |

```json
{
  "eventId": "d4e5...",
  "eventType": "PAYMENT_CONFIRMED",
  "occurredAt": "2026-09-26T07:16:03.000Z",
  "data": {
    "paymentId": "a9d2...",
    "orderId": "3f1a...",
    "externalOrderId": "svc-a-order-20260926-0001",
    "externalUserId": "user-123",
    "status": "DONE",
    "amount": 30000,
    "refundedAmount": 0,
    "currency": "KRW",
    "methodType": "CARD",
    "failureCode": null,
    "failureMessage": null
  }
}
```

| `eventType` | 발생 시점 |
|---|---|
| `PAYMENT_CONFIRMED` | 결제 승인 완료 (가상계좌는 입금 완료) |
| `PAYMENT_FAILED` | 결제 실패 확정 (대사 결과 포함) |
| `PAYMENT_WAITING_FOR_DEPOSIT` | 가상계좌 발급, 입금 대기 |
| `PAYMENT_CANCELED` | 전체·부분 환불 완료. `data.cancel`에 이번 취소 건(`paymentCancelId`, `amount`, `reasonCode`, `canceledAt`) |
| `ORDER_EXPIRED` | 결제 없이 주문 만료. `data`는 결제가 아니라 주문: `{ orderId, externalOrderId, externalUserId, status, totalAmount, currency, expiresAt }` |

`data`는 결제 "사실"만 담는다 — 서비스가 자기 주문을 찾을 수 있게 `externalOrderId`·`externalUserId`를 넣고, PG 응답 원본·원장은 넣지 않는다. `failureCode`·`failureMessage`는 `PAYMENT_FAILED`일 때 토스 원본 사유.

구현 상태:
- 서명 규격(`src/outbox/webhook-signature.ts`)과 서비스용 검증 예제([examples/webhook-signature-verify.ts](../examples/webhook-signature-verify.ts)) ✅ — 서로 맞는지 테스트된다
- 이벤트 기록 ✅ — 결제 승인 결과(`PAYMENT_CONFIRMED`·`PAYMENT_WAITING_FOR_DEPOSIT`·`PAYMENT_FAILED`)를 상태 변경과 같은 트랜잭션에서 `tb_outbox_event`에 남기고, 서비스에 `webhookUrl`이 있으면 전달 대상(`PENDING`)을 만든다
- 발송 워커 ✅ — 1초마다 due 건을 `FOR UPDATE SKIP LOCKED`로 가져가 보낸다 (여러 인스턴스 안전, 한 건은 한 번에 한 워커만). 서명은 **보내는 시점의** 서명 키로 한다

### 서비스 쪽 처리 규칙

1. 서명과 타임스탬프(5분 이내)를 검증한다
2. `eventId`로 이미 처리한 이벤트인지 확인한다
3. **2xx를 빠르게 응답**하고 무거운 후속 작업(프로비저닝 등)은 비동기로 처리한다
4. 2xx가 아니면(리다이렉트 포함, 응답 제한 10초) hub가 재시도한다 — 1분, 2분, 4분 … 최대 1시간 간격으로 **10번**까지(약 4시간). 넘으면 `DEAD` → admin이 재전송 (`POST /admin/ops/webhook-deliveries/:id/redeliver`). 재시도는 같은 `eventId`로 온다
5. **후속 처리가 실패해도 hub는 자동 환불하지 않는다.** 서비스가 판단해 `POST /payments/:id/cancel`을 호출한다

---

## 4-1. 토스 → hub 웹훅 (`POST /api/v1/pg-webhooks/toss`) ✅

토스 개발자센터의 웹훅 URL에 이 주소를 등록한다 (hub 운영자 작업). 서비스는 신경 쓰지 않아도 된다.

| 토스 이벤트 | 식별 | hub 동작 |
|---|---|---|
| `PAYMENT_STATUS_CHANGED` | `data.paymentKey` | 토스 조회로 재확인 후 반영 |
| 가상계좌 입금 콜백 (`DEPOSIT_CALLBACK`, `eventType` 없이 `secret`·`orderId`) | `orderId` | 같음 |
| 그 외 | | 대상 결제가 없거나 이미 확정됐으면 `IGNORED` |

- **페이로드를 신뢰하지 않는다.** 웹훅은 "바뀌었다"는 신호로만 쓰고, 토스 결제 조회 결과만 반영한다 (대사와 같은 경로). 그래서 인증 없는 공개 경로여도 위조 웹훅으로 상태를 바꿀 수 없다
- 입금 대기 가상계좌: 토스 `DONE` → `DONE`(주문 PAID·원장·`PAYMENT_CONFIRMED`), 입금 전 `EXPIRED`·`CANCELED` → `EXPIRED`(`PAYMENT_FAILED`)
- 같은 웹훅 재수신은 `(유형, paymentKey|orderId, 상태, 토스 발생 시각)` 키로 무시한다
- **항상 200.** 재확인에 실패하면 `FAILED`로 기록하고, 결제는 대사 배치가 이어받는다 (입금 대기 결제는 10분마다 토스 조회 — 웹훅을 놓쳐도 확정된다)
- 수신 내역은 `tb_pg_webhook_event`(`RECEIVED` → `PROCESSED`·`IGNORED`·`FAILED`)

---

## 5. 연동 순서 예시

### 새 서비스 온보딩 (admin)

```
1. POST /admin/services                               → serviceId, webhookSecret
2. POST /admin/services/:id/pg-credentials            → 토스 키 등록
3. POST /admin/services/:id/product-types             → PLAN, ADDON ...
4. POST /admin/services/:id/api-keys                  → apiKey (서비스 서버 env에 저장)
```

### 일반 결제

```
서비스 서버  POST /orders                        → orderId
서비스 프론트 GET /pg/client-config (서버 경유) → 토스 결제창(orderId, amount)
토스         → 서비스 프론트 successUrl?paymentKey=...&orderId=...&amount=...
서비스 서버  POST /payments/confirm              → DONE (즉시 응답)
hub          → 서비스 webhookUrl  PAYMENT_CONFIRMED (비동기)
```

### 정기결제

```
서비스 배치  POST /orders           → orderId
서비스 배치  POST /payments/billing  { orderId, billingKeyId, idempotencyKey }
```

### 환불

```
서비스 서버  GET  /payments/:id/refundable  → 환불 가능 금액 확인
서비스 서버  POST /payments/:id/cancel      { amount, reasonCode, idempotencyKey }
hub          → PAYMENT_CANCELED 웹훅
```
