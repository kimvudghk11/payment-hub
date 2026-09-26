# admin 연동 가이드

> **대상**: payment-hub를 관리하는 admin 레포(관리자 백엔드·화면) 개발자
> **함께 볼 것**: API 계약 [docs/api.md 2장](../api.md#2-관리자-api-apiv1admin) · OpenAPI [docs/openapi.json](../openapi.json) · 예제 [examples/admin-client.ts](../../examples/admin-client.ts)
> 예제 클라이언트는 실제 hub에 붙여 자동 테스트된다 (`test/docs/example-clients.int-spec.ts`).

## 목차

1. [책임 경계](#1-책임-경계)
2. [admin 키 발급·배포](#2-admin-키-발급배포)
3. [호출 공통 규칙](#3-호출-공통-규칙)
4. [서비스 온보딩 절차](#4-서비스-온보딩-절차)
5. [화면별 API 매핑](#5-화면별-api-매핑)
6. [운영 절차](#6-운영-절차)
7. [에러 코드별 대응](#7-에러-코드별-대응)

---

## 1. 책임 경계

| admin 레포 | payment-hub |
|---|---|
| 관리자 로그인, 권한(RBAC), 화면 | 관리 대상 데이터와 도메인 규칙 |
| "누가" 작업했는지 인증 → `X-Admin-Actor-Id`로 전달 | actor를 신뢰하고 감사 로그에 기록 |
| hub DB에 **직접 접근하지 않음** | 모든 관리 쓰기를 API로만 받고, 같은 트랜잭션에서 감사 로그 기록 |

- hub는 actor 헤더를 검증하지 않고 **신뢰**한다. 그래서 admin API는 네트워크에서도 막는다(내부망·IP 허용 목록). 서비스 API와 같은 공개 경로로 노출하지 않는다
- 관리자 권한 확인(예: "환불은 재무 권한만")은 admin 레포가 hub를 호출하기 **전에** 한다

**구현 상태**: 서비스·API 키·PG 자격증명·상품 유형 관리 ✅ / 결제 조회 ✅ / 수동 환불·운영 큐·리포트·감사 로그 조회 🚧 (계약은 [api.md 2.5](../api.md#25-결제-조회운영))

---

## 2. admin 키 발급·배포

```bash
# hub 레포에서
npm run admin-key:generate
```

```
1) admin 레포 서버 환경변수 (평문, 외부 노출 금지)
   PAYMENT_HUB_ADMIN_API_KEY=phadm_ndNR7_...

2) payment-hub 환경변수 (해시만. 기존 값이 있으면 쉼표로 이어 붙임)
   ADMIN_API_KEY_HASHES=6df351a2...
```

- hub에는 **해시만** 넣는다. 평문은 admin 레포 서버에만 둔다
- `ADMIN_API_KEY_HASHES`에 형식이 틀린 값이 있으면 hub가 부팅하지 않는다 (오타가 조용히 무시되지 않게)

**키 교체 (무중단)**: 새 키 생성 → hub의 `ADMIN_API_KEY_HASHES`에 새 해시 **추가** 배포 → admin 레포를 새 키로 배포 → hub에서 구 해시 제거 배포

---

## 3. 호출 공통 규칙

### 헤더

| 헤더 | 필수 | 설명 |
|---|---|---|
| `Authorization` | ✅ | `Bearer <PAYMENT_HUB_ADMIN_API_KEY>` |
| `X-Admin-Actor-Id` | ✅ | 로그인한 관리자 ID (100자 이하). 없으면 `400 ADMIN_ACTOR_REQUIRED` |
| `X-Admin-Actor-Name` | | 관리자 이름, **URL 인코딩** (`encodeURIComponent('홍길동')`) |
| `X-Request-Id` | | admin 레포 요청 ID. 감사 로그와 admin 로그를 잇는 데 사용 |

```ts
import { PaymentHubAdminClient } from './payment-hub/admin-client';

const hub = new PaymentHubAdminClient({
  baseUrl: process.env.PAYMENT_HUB_URL!,
  adminKey: process.env.PAYMENT_HUB_ADMIN_API_KEY!,
});

// 요청마다 실제 작업한 관리자를 넘긴다
const actor = { actorId: session.adminId, actorName: session.adminName, requestId: req.id };
await hub.suspendService(actor, serviceId, '결제 이상 거래 조사');
```

### 응답·에러

- 성공: `{ success: true, message, data }` — `message`는 그대로 토스트 문구로 써도 된다
- 실패: `{ success: false, code, message, detail? }` — **분기는 `code`로**, `message`는 화면 표시용 한국어
- 검증 실패: `400 INVALID_REQUEST`, `detail.errors = [{ field, message }]` → 폼 필드 에러로 표시

### 감사 로그와 사유

- **모든 쓰기는 hub가 같은 트랜잭션에서 감사 로그를 남긴다.** admin 레포가 따로 기록할 필요 없다 (조회 API 🚧)
- 아래 작업은 `reason`이 없으면 `400 ADMIN_REASON_REQUIRED` → 화면에서 사유 입력을 필수로 받는다

| 작업 | API |
|---|---|
| 서비스 정지 | `POST /admin/services/:id/suspend` |
| 서비스 삭제 | `DELETE /admin/services/:id` |
| PG 자격증명 비활성 | `POST /admin/pg-credentials/:id/deactivate` |
| 수동 환불 🚧 | `POST /admin/payments/:id/cancel` |

### 재시도해도 안전하다

정지·재개·키 폐기·PG 비활성은 **이미 그 상태면 200으로 현재 상태를 돌려주고 감사 로그를 남기지 않는다.** 버튼 연타·네트워크 재시도가 에러나 중복 기록이 되지 않는다.

---

## 4. 서비스 온보딩 절차

새 서비스 연동은 아래 4단계로 끝난다. 서비스별 코드 변경은 없다.

```ts
// 1) 서비스 등록 — webhookSecret은 이 응답에서만 볼 수 있다
const service = await hub.createService(actor, {
  code: 'SVC_A',                                   // 영문 대문자·숫자·_ 2~20자, 전역 유일
  name: '서비스 A',
  webhookUrl: 'https://svc-a.example.com/webhooks/payment-hub',  // LIVE는 https만
});

// 2) 상품 유형 — 서비스가 파는 상품의 "종류" (개별 상품·가격은 서비스가 관리)
await hub.createProductType(actor, service.serviceId, { code: 'PLAN', name: '구독 요금제' });
await hub.createProductType(actor, service.serviceId, { code: 'ADDON', name: '부가 상품' });

// 3) PG 자격증명 — 서비스 담당자에게 받은 토스 키. 시크릿 키는 이후 어디에서도 다시 볼 수 없다
await hub.registerPgCredential(actor, service.serviceId, {
  environment: 'LIVE',               // 이 hub 배포의 환경과 같아야 사용됨
  merchantId: 'tosspayments_mid',
  clientKey: 'live_ck_...',
  secretKey: 'live_sk_...',          // test_ 키를 LIVE로 넣으면 400
});

// 4) API 키 발급 — apiKey는 이 응답에서만 볼 수 있다
const { apiKey } = await hub.issueApiKey(actor, service.serviceId, { label: 'prod-server' });
```

### 서비스 담당자에게 전달할 것

| 값 | 출처 | 전달 방법 |
|---|---|---|
| hub URL | 배포 설정 | 일반 문서 |
| API 키 `ph_live_…` | 4단계 응답 | **비밀 공유 채널** (1회성 링크, 비밀 저장소). 메신저·메일 평문 금지 |
| 웹훅 서명 키 `whsec_…` | 1단계 응답 | 위와 같음 |
| 상품 유형 코드 | 2단계 | 일반 문서 |
| 연동 가이드 | [service-integration.md](service-integration.md) | 링크 |

- 평문 키를 admin 레포 DB나 로그에 **저장하지 않는다.** 화면에 한 번 보여주고 "복사했습니다" 확인 후 버린다
- 잃어버리면 복구할 수 없다 → API 키는 새로 발급, 서명 키는 교체한다

---

## 5. 화면별 API 매핑

| 화면 | 동작 | API | 비고 |
|---|---|---|---|
| **서비스 목록** | 조회 | `GET /admin/services?status=&includeDeleted=&limit=&cursor=` | 최신순, `nextCursor`로 다음 페이지 |
| **서비스 등록** | 등록 | `POST /admin/services` | 완료 화면에서 `webhookSecret` 1회 표시 |
| **서비스 상세** | 조회 | `GET /admin/services/:id` | 서명 키는 `hasWebhookSecret`(발급 여부)만 |
| | 이름·웹훅 URL 수정 | `PATCH /admin/services/:id` | `webhookUrl: null` = 웹훅 중지 |
| | 정지 / 재개 | `POST …/suspend` (사유 필수) / `POST …/resume` | 정지 즉시 서비스 API 전부 `403` |
| | 삭제 | `DELETE /admin/services/:id` (사유 필수) | soft delete. 이후 조회는 `404`, 결제 이력은 보존 |
| | 웹훅 서명 키 교체 | `POST …/webhook-secret/rotate` | 새 키 1회 표시 |
| **API 키** | 목록 | `GET /admin/services/:id/api-keys` | prefix·끝 4자리·만료·**마지막 사용 시각** |
| | 발급 | `POST /admin/services/:id/api-keys` | 새 키 1회 표시 |
| | 폐기 | `POST /admin/api-keys/:apiKeyId/revoke` | 폐기 즉시 해당 키 `401 API_KEY_REVOKED` |
| **PG 자격증명** | 목록 | `GET /admin/services/:id/pg-credentials` | 시크릿 키는 끝 4자리만 |
| | 등록(교체) | `POST /admin/services/:id/pg-credentials` | 같은 환경의 기존 키는 자동 비활성 |
| | 비활성 | `POST /admin/pg-credentials/:id/deactivate` (사유 필수) | 활성 키가 없으면 해당 서비스 결제 불가 |
| **상품 유형** | 목록 | `GET /admin/services/:id/product-types?isActive=` | 코드순 |
| | 등록 | `POST /admin/services/:id/product-types` | 같은 코드 `409 PRODUCT_TYPE_DUPLICATED` |
| | 수정·중지·재개 | `PATCH …/product-types/:code` `{ name?, isActive? }` | **삭제 없음** — 중지는 새 주문에만 영향 |
| **결제 검색** | 조회 | `GET /admin/payments?serviceId=&status=&paymentKey=&externalUserId=…` | CS: 토스 paymentKey·사용자 ID로 찾기. `status`는 쉼표로 여러 개 |
| **결제 상세** | 조회 | `GET /admin/payments/:id` | 주문·취소 이력·원장 분개·웹훅 전달 내역·PG 응답 원본을 한 화면에 |
| 수동 환불·운영·리포트·감사 로그 🚧 | | [api.md 2.5](../api.md#25-결제-조회운영) | |

---

## 6. 운영 절차

### API 키 교체 (무중단)

1. 새 키 발급 → 서비스 담당자에게 전달
2. 서비스가 새 키로 배포 (배포 후 `GET /me`로 확인)
3. 키 목록에서 **구 키의 `lastUsedAt`이 더 이상 갱신되지 않는지** 확인
4. 구 키 폐기

### PG 자격증명 교체

새 키를 등록하면 같은 환경의 기존 키는 **같은 트랜잭션에서 자동 비활성**되어, 활성 키가 없는 순간이 생기지 않는다. 감사 로그 `before`에 이전 키 정보가 남는다.

### 웹훅 서명 키 교체

교체 즉시 hub는 새 키로 서명한다. 서비스가 env를 갱신하기 전까지 서명 검증이 실패하고, 그동안의 웹훅은 **재시도 대기**로 남았다가 갱신 후 전달된다 (재시도는 약 4시간까지 — 그 안에 env를 갱신하지 못하면 `DEAD`가 되어 재전송이 필요하다). 서비스 담당자와 시간을 맞춰 진행한다.

### 서비스 정지·삭제의 영향

| 작업 | 서비스 API | 기존 결제·데이터 | 되돌리기 |
|---|---|---|---|
| 정지 | 전부 `403 SERVICE_SUSPENDED` | 유지 | 재개 |
| 삭제 | 전부 `401` (존재를 숨김) | 유지 (soft delete) | 불가 — 같은 코드로 재등록도 불가 |

---

## 7. 에러 코드별 대응

| code | status | 화면 처리 |
|---|---|---|
| `UNAUTHORIZED` | 401 | admin 키 설정 오류 → 운영 알림 (사용자 문제 아님) |
| `ADMIN_ACTOR_REQUIRED` | 400 | admin 레포 버그 (actor 헤더 누락) |
| `ADMIN_REASON_REQUIRED` | 400 | 사유 입력 요청 |
| `INVALID_REQUEST` | 400 | `detail.errors`를 폼 필드 에러로 표시 |
| `RESOURCE_NOT_FOUND` | 404 | 삭제됐거나 없는 대상 → 목록 새로고침 |
| `SERVICE_CODE_DUPLICATED` | 409 | "이미 사용 중인 서비스 코드" (삭제된 서비스 코드도 재사용 불가) |
| `PRODUCT_TYPE_DUPLICATED` | 409 | "이미 등록된 상품 유형" |
| `INTERNAL_ERROR` | 500 | 재시도 안내, 계속되면 hub 로그 확인 (`X-Request-Id`로 추적) |
