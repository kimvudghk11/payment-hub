# payment-hub

> 여러 서비스의 결제를 하나로 모으는 **결제 허브 서버**
> 토스페이먼츠 연동 · 결제 이력 · 복식부기 원장 · 결제 이벤트 전달을 한 곳에서 책임진다.

![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-4169E1?logo=postgresql&logoColor=white)
![TypeORM](https://img.shields.io/badge/TypeORM-0.3-FE0803)

---

## 왜 만들었나

여러 서비스를 운영하는 조직에서 서비스마다 PG 연동 코드, 키 관리, 결제 이력이 흩어져 있으면 다음 문제가 생긴다.

- **중복 코드**: 서비스마다 같은 PG 승인·취소·조회 코드를 따로 유지
- **상태 불일치**: 타임아웃 등으로 "돈은 나갔는데 기록이 없는" 결제가 서비스마다 다른 방식으로 방치됨
- **응답 지연**: 결제 후 후속 작업(프로비저닝, 알림)이 결제 요청에 동기로 묶임

payment-hub는 **"결제만"** 중앙화한다. 주문 서버를 따로 두지 않고, 주문 도메인은 각 서비스가 들고 허브에는 결제에 필요한 값만 넘긴다.
작은 조직이 주문 서버까지 분리하는 비용은 과하다고 판단했다.

```
대기업형:     서비스 → 주문 서버 → 결제 서버 → 서비스
payment-hub: 서비스(+주문) → payment-hub → 서비스(웹훅)
```

---

## 아키텍처

```mermaid
flowchart LR
    subgraph Services["연동 서비스 (A, B, C ...)"]
        SVC[서비스 서버]
    end
    ADMIN[admin 레포<br/>관리자 백엔드]

    subgraph HUB["payment-hub"]
        API["/api/v1/*<br/>서비스 API"]
        ADM["/api/v1/admin/*<br/>관리자 API"]
        DB[(PostgreSQL<br/>결제 · 원장 · outbox)]
        POLL[웹훅 전달 폴러]
        RECON[대사 배치]
    end

    TOSS[토스페이먼츠]

    SVC -- API 키 --> API
    ADMIN -- admin 키 + actor 헤더 --> ADM
    API --> DB
    ADM --> DB
    API -- 승인·빌링·취소 --> TOSS
    RECON -- 조회 --> TOSS
    TOSS -- 가상계좌 입금 등 웹훅 --> HUB
    POLL -- HMAC 서명 웹훅 --> SVC
    DB -. outbox .-> POLL
```

### 책임 경계 — 허브는 서비스의 비즈니스를 모른다

| payment-hub | 각 서비스 |
|---|---|
| 토스 API 호출, 결제·취소 이력, 원장 기장 | 상품·구독·쿠폰, 금액·할인·환불 금액 계산 |
| 사전 등록 금액 고정, confirm 시 금액 대조 | 정기결제 스케줄·재시도 정책 |
| 범용 결제 이벤트 발행 | 이벤트 수신 후 후속 처리, 실패 시 직접 취소 요청 |

새 서비스 연동은 **서비스 등록 + API 키 발급 + 상품 유형 등록 + PG 자격증명 등록**만으로 끝난다. 서비스별 분기 코드는 없다.

---

## 핵심 설계 포인트

### 1. 외부 호출 전에 먼저 기록한다 — 결과를 모르면 `UNKNOWN`
토스 호출 전에 `IN_PROGRESS`로 저장하고, DB 트랜잭션 **밖에서** 토스를 호출한 뒤, 결과를 별도 트랜잭션으로 반영한다.
타임아웃이면 `UNKNOWN`으로 남기고 대사 배치가 토스 조회 API로 확정한다.

```mermaid
sequenceDiagram
    participant S as 서비스
    participant H as payment-hub
    participant T as 토스
    S->>H: POST /payments/confirm {orderId, paymentKey, amount}
    H->>H: tx1: 금액·소유·만료 검증, payment IN_PROGRESS 저장
    H->>T: 승인 요청 (Idempotency-Key)
    alt 성공
        T-->>H: DONE
        H->>H: tx2: payment DONE · order PAID · 원장 기장 · outbox INSERT
    else 타임아웃
        H->>H: payment UNKNOWN → 대사 배치가 확정
    end
    H-->>S: 즉시 응답 (후속 처리는 웹훅으로 비동기)
```

### 2. 서비스 소유권은 DB가 강제한다
주문·항목·결제·취소·빌링키를 `(id, service_id)` **복합 FK**로 연결한다. 코드 버그가 있어도 서비스 B의 결제가 서비스 A의 주문에 붙을 수 없다.

### 3. append-only 복식부기 원장
- 차변 합 = 대변 합을 **커밋 시점 제약 트리거**로 강제
- 원장 테이블의 UPDATE/DELETE는 트리거로 차단, 정정은 `ADJUSTMENT` 반대 분개로만
- `(transaction_type, reference_type, reference_id)` 유니크로 같은 사건의 이중 기장 불가
- 매출·환불 리포트는 별도 집계 테이블 없이 원장에서 집계

| 사건 | 차변 | 대변 |
|---|---|---|
| 결제 승인 | PG_RECEIVABLE | REVENUE |
| 결제 취소 | REFUND | PG_RECEIVABLE |
| PG 정산 입금 | CASH + PG_FEE | PG_RECEIVABLE |

### 4. 모든 쓰기 요청은 멱등하다
주문 `(service_id, external_order_id)`, 결제 `idempotency_key`(토스 `Idempotency-Key`로도 전달), 취소 `(service_id, idempotency_key)`.
같은 키로 재요청하면 에러가 아니라 기존 결과를 돌려준다. 한 주문에 살아있는 결제는 **부분 유니크 인덱스**로 1건만 허용해 이중 결제를 막는다.

### 5. Transactional Outbox + 신뢰성 있는 웹훅 전달
- 결제 상태 변경과 `tb_outbox_event` INSERT를 한 트랜잭션으로 묶는다
- 폴러가 `FOR UPDATE SKIP LOCKED`로 전달 건을 가져가므로 인스턴스를 여러 개 띄워도 안전하다. `locked_until`로 죽은 워커의 작업을 회수한다
- HMAC 서명, 지수 백오프 재시도, 한도 초과 시 `DEAD` → 관리자 재전송
- 전달 이벤트(불변)와 전달 상태(가변)를 테이블로 분리

### 6. 보안
- 토스 시크릿 키·빌링키·웹훅 서명 키는 암호화(`*_enc bytea` + `*_key_id`)해 저장한다. 키 교체에 대비해 어떤 키로 암호화했는지 함께 남긴다
- API 키는 SHA-256 해시만 저장하고, 평문은 발급할 때 한 번만 응답한다
- 서비스 API와 관리자 API는 경로·인증 키·데이터 범위가 완전히 분리된다. 가드는 기본 거부(default deny)
- 관리자 쓰기는 모두 같은 트랜잭션에서 append-only 감사 로그를 남긴다

### 7. 금액과 상태 값
- 금액은 모두 `bigint` **최소 통화 단위**(KRW 10,000원 = `10000`, USD $12.34 = `1234`). float는 쓰지 않는다
- 상태 값은 PostgreSQL enum 대신 `varchar + CHECK`로 제한한다. 값을 추가·삭제할 때 마이그레이션 부담이 적다

---

## 데이터 모델

```
[서비스]  tb_service ─┬─ tb_service_api_key       서비스당 여러 키 (무중단 교체)
                      ├─ tb_pg_credential          서비스·환경별 토스 키 (암호화, 활성 1개)
                      └─ tb_service_product_type   상품 유형 화이트리스트
[수단]    tb_billing_key                           빌링키(암호화) + 마스킹 카드 정보
[주문]    tb_order ── tb_order_item                서비스가 사전 등록, 금액 고정
[결제]    tb_payment ── tb_payment_cancel ── tb_payment_cancel_item
[원장]    tb_ledger_account / tb_ledger_transaction ── tb_ledger_entry
[이벤트]  tb_outbox_event ── tb_webhook_delivery   hub → 서비스
          tb_pg_webhook_event                      토스 → hub (dedup_key)
[관리]    tb_admin_audit_log                       관리자 작업 감사 로그 (append-only)
```

전체 DDL: [`db/schema.sql`](./db/schema.sql) — 스키마의 단일 진실 공급원(SSOT). 엔티티는 이 파일을 따른다.

### 상태 머신 (결제)

```mermaid
stateDiagram-v2
    [*] --> IN_PROGRESS
    IN_PROGRESS --> DONE
    IN_PROGRESS --> FAILED
    IN_PROGRESS --> ABORTED
    IN_PROGRESS --> UNKNOWN
    IN_PROGRESS --> WAITING_FOR_DEPOSIT
    UNKNOWN --> DONE: 대사
    UNKNOWN --> FAILED: 대사
    WAITING_FOR_DEPOSIT --> DONE: 입금
    WAITING_FOR_DEPOSIT --> EXPIRED
    DONE --> PARTIAL_CANCELED
    DONE --> CANCELED
    PARTIAL_CANCELED --> CANCELED
```

---

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| Framework | NestJS 11, TypeScript |
| DB | PostgreSQL 15+, TypeORM 0.3, typeorm-transactional |
| Validation / Docs | class-validator, class-transformer, Swagger |
| Batch | @nestjs/schedule (웹훅 폴러, 대사 배치, 주문 만료) |
| PG | 토스페이먼츠 (일반 결제, 빌링 자동결제, 가상계좌) |
| Test | Jest, Supertest |

---

## 연동하기

이 레포와 아래 문서만으로 서비스·admin 연동을 시작할 수 있다. 문서의 예제 코드는 실제 hub에 붙여 자동 테스트된다.

| 누가 | 시작점 | 내용 |
|---|---|---|
| 결제를 붙이는 서비스 개발자 | [docs/guides/service-integration.md](./docs/guides/service-integration.md) | 받을 값, 호출 규칙, 결제 흐름, 웹훅 서명 검증, 에러 대응, 체크리스트 |
| admin 레포 개발자 | [docs/guides/admin-integration.md](./docs/guides/admin-integration.md) | admin 키, 온보딩 절차, 화면별 API, 키 교체 등 운영 절차 |
| 공통 | [docs/api.md](./docs/api.md) · [docs/openapi.json](./docs/openapi.json) | API 계약 전체 · 클라이언트 생성용 스펙 (코드와 불일치 시 테스트 실패) |
| 예제 코드 | [examples/](./examples) | 서비스·admin 클라이언트, 웹훅 서명 검증 (Node 내장 모듈만 사용) |

로컬에서 바로 붙여 보기:

```bash
npm run admin-key:generate      # admin 키 생성 → 해시를 .env ADMIN_API_KEY_HASHES에
npm run db:up && npm run start:dev
HUB_URL=http://localhost:3000 ADMIN_API_KEY=phadm_... npm run local:onboard   # 테스트 서비스·API 키 준비
```

---

## 실행 방법

**요구 사항**: Node.js 20+, Docker

```bash
# 1. 의존성 설치
npm install

# 2. 환경 변수 — ENCRYPTION_KEYS가 비어 있으면 부팅이 실패한다
cp .env.example .env
echo "ENCRYPTION_KEYS=v1:$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" >> .env
# 관리자 API를 쓰려면 ADMIN_API_KEY_HASHES에 admin 키의 SHA-256 hex를 넣는다

# 3. PostgreSQL 기동 — 최초 기동 시 db/schema.sql이 자동 적용됨
npm run db:up

# 4. 개발 서버
npm run start:dev
```

- API: `http://localhost:3000/api/v1`
- Swagger: `http://localhost:3000/docs` (production 환경에서는 비활성)

스키마를 바꾼 뒤에는 볼륨을 지우고 다시 띄운다: `docker compose down -v && npm run db:up`

| 스크립트 | 설명 |
|---|---|
| `npm run build` | 프로덕션 빌드 |
| `npm run lint` | ESLint (type-checked) |
| `npm test` | 단위 테스트 (`test/**/*.spec.ts`, DB 불필요) |
| `npm run test:integration` | 통합 테스트 (`test/**/*.int-spec.ts`). `payment_hub_test` DB를 새로 만들고 `db/schema.sql` 적용 |
| `npm run openapi:export` | `docs/openapi.json` 재생성 (DB 불필요). API를 바꾸면 실행해 함께 커밋 |
| `npm run admin-key:generate` | admin 레포용 관리자 키와 hub에 넣을 해시 생성 |
| `npm run local:onboard` | 로컬 hub에 테스트 서비스·상품 유형·토스 테스트 키·API 키 준비, 서비스 .env 값 출력 |

`db/schema.sql`이 SSOT이고 TypeORM `synchronize`를 쓰지 않는다. 대신 `test/schema/`의 적합성 테스트가 엔티티와 스키마(테이블·컬럼·타입·길이·nullable·PK·FK), 상태 constants와 DB CHECK 값이 어긋나지 않는지 검증한다.

---

## 프로젝트 구조

```
db/schema.sql           DB 스키마 (SSOT)
src
├── common/             공통 설정, 에러, 필터, 가드, 암호화
├── pg/                 토스 API 클라이언트
├── service/            서비스·API 키·PG 자격증명·상품 유형
├── billing-key/        빌링키
├── order/              주문 사전 등록·조회·만료
├── payment/            confirm·billing·cancel, 대사 배치
├── ledger/             복식부기 원장
├── outbox/             outbox 이벤트, 웹훅 전달 폴러
├── pg-webhook/         토스 웹훅 수신
└── admin/              관리자 API (/api/v1/admin/*)
```

---

## 진행 상황

- [x] 설계 원칙·책임 경계·API 표면 정의 ([CLAUDE.md](./CLAUDE.md))
- [x] DB 스키마 (17개 테이블, 복합 FK, 원장 트리거)
- [x] NestJS 프로젝트 초기 세팅
- [x] 전체 테이블 엔티티 매핑 + 상태 constants + 스키마 적합성 테스트
- [x] 공통: 에러 코드·예외 필터, 금액 transformer
- [x] 인증: 기본 거부 전역 가드, 관리자 인증(AdminGuard)
- [x] API 명세 ([docs/api.md](./docs/api.md))
- [x] 서비스 API 키 인증(ApiKeyGuard), 연결 확인 `GET /me`
- [x] 관리자 API: 서비스 등록·수정·정지·재개·삭제, 웹훅 서명 키 교체, API 키 발급·폐기 (감사 로그 같은 트랜잭션)
- [x] 관리자 API: PG 자격증명(암호화 저장·환경 prefix 검증), 상품 유형 — **서비스 온보딩 완성**
- [x] 서비스 API: 결제창 설정 `GET /pg/client-config`
- [x] 주문 사전 등록·조회 (금액 고정, 상품 유형 검증, 멱등·동시 요청 안전)
- [x] 연동 준비: 연동 가이드, OpenAPI 스펙(최신 여부 테스트), 테스트된 예제 클라이언트, 웹훅 서명 규격, 로컬 온보딩 스크립트
- [x] 결제 승인: 토스 클라이언트, 선기록(IN_PROGRESS) → 승인 → 결과 반영·원장 기장·outbox 이벤트 한 트랜잭션, 타임아웃은 UNKNOWN
- [x] 결제 조회: 단건, 사용자별 이력(상태·수단 필터), 환불 가능 금액
- [x] 환불 (전체·부분, 처리 중 환불까지 뺀 상한, 항목별 취소 수량, 원장 반대 분개, PAYMENT_CANCELED)
- [ ] 빌링 자동결제, 가상계좌 입금(토스 웹훅), 환불 대사
- [x] 웹훅 발송 워커 (SKIP LOCKED 획득·임대, 서명, 지수 백오프 재시도, DEAD)
- [x] 대사 배치 (UNKNOWN·멈춘 IN_PROGRESS를 토스 조회로 확정, 응답-기록 불일치는 확정 안 함)
- [x] 관리자 결제 조회·상세, 운영 큐(실패 웹훅 재전송·수동 대사), 수동 환불 (감사 로그 같은 트랜잭션)
- [ ] 매출 리포트, 감사 로그 조회

- API 명세: [docs/api.md](./docs/api.md) · 연동 가이드: [서비스](./docs/guides/service-integration.md) / [admin](./docs/guides/admin-integration.md)
- 변경 이력과 각 결정의 이유: [CHANGELOG.md](./CHANGELOG.md)
