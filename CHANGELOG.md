# Changelog

이 프로젝트의 모든 변경 이력을 기록한다. 작성 규칙은 [CLAUDE.md 10장](./CLAUDE.md#10-변경-이력-관리-changelogmd) 참고.

## [Unreleased]

### 2026-09-26

#### docs: API 명세 문서(docs/api.md) 추가
- **무엇을**: 관리자 API(서비스 등록·수정·정지·삭제, API 키 발급·폐기, PG 자격증명, 상품 유형 등록·수정·중지, 결제 운영)와 서비스 API(주문, 결제 승인·빌링, 사용자별 결제 조회, 환불 가능 금액, 환불, 빌링키, 이벤트 재조회), hub → 서비스 웹훅 서명 규격, 연동 순서를 한 문서로 정리. API별 구현 상태(✅/🚧) 표시
- **왜**:
  - 서비스 개발자와 admin 레포 개발자가 코드 없이 연동 계약을 확인할 수 있어야 함. CLAUDE.md는 원칙 문서라 요청·응답 예시까지 담기엔 컨텍스트 비용이 큼
  - "서비스 상품 관리" 요구는 hub 책임 경계(상품을 모름)에 맞춰 **상품 유형** 관리로 정리. 삭제 대신 `isActive: false` (주문 항목 FK 참조)
  - "결제 수단 등록" 요구는 결제 건의 수단 분류(`method.type`, 카드사, 카드 종류 등)와 기존 빌링키 등록으로 정리
  - 결정 사항: 배포 하나 = PG 환경 하나(`PG_ENVIRONMENT`) — 결제·원장에 환경 컬럼이 없으므로 테스트 결제가 운영 리포트에 섞이지 않게 배포·DB를 분리. 결제 승인 멱등키는 `paymentKey` 기반으로 hub가 생성. 가상계좌 환불 계좌는 토스에 전달만 하고 저장하지 않음(개인정보 최소 보관). 웹훅 서명 `HMAC-SHA256(secret, "<timestamp>.<body>")`
- **변경 파일**: `docs/api.md`, `CLAUDE.md`, `.env.example`, `README.md`
- **문서**: CLAUDE.md 6장에 API 계약 기준 문서(`docs/api.md`)와 배포-환경 규칙 추가, 8장 `IPageable`에 `nextCursor` 추가
- **남은 작업 / 주의**: 문서의 🚧 API는 이후 커밋에서 구현하며 상태 표시를 함께 갱신

#### schema(payment): 결제 수단 분류 컬럼 추가 및 결제 멱등키 서비스 단위 유니크로 변경
- **무엇을**:
  - `tb_payment`에 결제 수단 분류 컬럼 추가: `method_type`(CHECK), `card_company_code`, `card_type`(CHECK), `card_number_masked`, `installment_months`, `easy_pay_provider`, `bank_code`, `virtual_account_number`, `virtual_account_due_at`
  - `uq_tb_payment_idempotency`: `UNIQUE (idempotency_key)` → `UNIQUE (service_id, idempotency_key)`
  - `PaymentMethodType`, `CardType` constants 추가, `Payment` 엔티티 매핑, 적합성 테스트 대응표 갱신
- **왜**:
  - 결제 조회 필터(카드만, 가상계좌만)와 매출 리포트의 수단별 분류가 필요. 토스 `method` 원문은 한국어 문자열이라 분기·집계 키로 쓰기 어려워 hub가 정규화한 값을 따로 둠. 카드사·은행 코드는 토스가 정의하는 값이라 CHECK 없이 원문 저장 (설계 원칙 2)
  - 가상계좌는 입금 전까지 서비스가 사용자에게 계좌번호·기한을 안내해야 하므로 결제 행에 보관
  - 빌링 결제 멱등키는 서비스가 보내는 값이라 전역 유니크면 서비스 간 우연한 충돌로 다른 서비스 결제가 실패함. 취소(`(service_id, idempotency_key)`)와 규칙 통일
- **변경 파일**: `db/schema.sql`, `src/payment/constants/payment.constants.ts`, `src/payment/domain/payment.entity.ts`, `test/schema/constants-check.int-spec.ts`, `CLAUDE.md`
- **스키마/에러 코드**: `tb_payment` 컬럼 9개·CHECK 3개 추가, 결제 멱등 유니크 키 변경
- **문서**: CLAUDE.md 설계 원칙 5(결제 멱등키 범위), 4장 "결제 수단 분류" 추가
- **남은 작업 / 주의**: 토스 응답 → 분류 컬럼 정규화 매핑은 결제 승인 구현 시. 기존 DB가 있다면 `docker compose down -v`로 재생성 필요

#### feat(common): 에러 코드·BusinessException·전역 예외 필터 추가
- **무엇을**:
  - `src/common/errors/error-code.ts`: CLAUDE.md 기본 에러 코드 25개. 정의는 `{ status, message }`만 쓰고 `code`(=키)는 자동 부여
  - `BusinessException(ErrorCode.X, detail?)`
  - `HttpExceptionFilter`(`@Catch()` 전체): `{ success: false, code, message, detail? }`로 변환. Nest 내장 400/401/404는 hub 코드로 매핑, 그 외·예상 못 한 예외는 `500 INTERNAL_ERROR` + 스택은 로그로만
  - `validationExceptionFactory`: 검증 실패 → `400 INVALID_REQUEST`, `detail.errors = [{ field, message }]`. 중첩 필드 점 경로, 정의되지 않은 필드는 한국어 메시지로 대체
  - `src/app.setup.ts` `setupApp()`: prefix·ValidationPipe·필터를 한 곳에 모아 `main.ts`와 테스트가 공유
- **왜**:
  - 서비스는 에러 `code`로 분기하므로 코드명과 응답의 `code`가 어긋나면 안 됨 → 키에서 `code`를 파생해 오타·불일치 원천 차단
  - `BusinessException`이 코드 정의 객체를 그대로 받으면 역조회 없이 필터가 status·code·message를 꺼낼 수 있음
  - SQL 에러 메시지·스택이 응답으로 새면 스키마·내부 구조가 노출됨
  - 테스트가 main.ts와 다른 설정으로 앱을 띄우면 테스트가 실제 동작을 보장하지 못함
- **변경 파일**: `src/common/errors/*`, `src/common/filters/http-exception.filter.ts`, `src/app.setup.ts`, `src/main.ts`, `test/common/error-code.spec.ts`, `test/common/error-response.spec.ts`, `CLAUDE.md`
- **스키마/에러 코드**: 에러 코드 25개 구현 (CLAUDE.md 표와 동일, 추가·변경 없음)
- **문서**: CLAUDE.md 8장 에러 처리 — ErrorCode 정의 방식, `setupApp()`, 검증 에러 형식, Nest 내장 예외 매핑 규칙 추가
- **남은 작업 / 주의**:
  - 토스 에러 → hub 코드 매핑(`detail.pgCode`/`pgMessage`)은 PG 클라이언트 구현 시
  - 검증 메시지 공통 util(`validation-message.util.ts`)은 첫 요청 DTO 작성 시. 그 전까지 DTO에 메시지를 빠뜨리면 class-validator 영문 기본 메시지가 나감
  - 성공 응답 래퍼(`IResponseBase`, `@ResponseMessage` 인터셉터)는 별도 커밋

#### feat(entity): 전체 테이블 엔티티 매핑 및 상태 constants 추가
- **무엇을**:
  - `db/schema.sql` 17개 테이블 전부 TypeORM 엔티티로 매핑 (`src/<domain>/domain/*.entity.ts`). 컬럼 매핑만 하고, 정적 팩토리·행위 메서드는 각 유스케이스 구현 시 TDD로 추가
  - 베이스 클래스 `CreatedAtEntity`(created_at) ← `BaseEntity`(+updated_at). 시간 컬럼 구성이 다른 3개 테이블은 상속 없이 직접 선언
  - 객체 관계는 애그리거트 내부만: Order→OrderItem, Payment→PaymentCancel→PaymentCancelItem, LedgerTransaction→LedgerEntry. 복합 FK `(id, service_id)`는 `@JoinColumn([...])`으로 매핑
  - 도메인별 상태 constants (`src/<domain>/constants/*.constants.ts`) — DB CHECK 값과 1:1
  - 금액 bigint transformer `bigintAmountTransformer` (문자열 → number, 안전 정수 범위 밖이면 예외, 저장 시 정수 아닌 값 거부)
  - 통합 테스트 인프라: `npm run test:integration`, `test/jest-integration.json`, 테스트 DB 재생성 + 스키마 적용 globalSetup
  - 스키마 적합성 테스트: 엔티티 ↔ 스키마(테이블·컬럼 양방향·타입·길이·nullable·PK·FK), constants ↔ CHECK 값, CHECK 제약의 constants 누락 검사
  - `db/schema.sql` API 키 prefix 주석 `pl_live_` → `ph_live_` / `ph_test_`
  - 첫 커밋에서 heredoc 때문에 백슬래시가 빠진 jest `testRegex`/`transform` 정규식 수정 (`.int-spec.ts`까지 단위 테스트로 잡히던 문제)
- **왜**:
  - 스키마가 확정돼 있어 매핑을 먼저 깔면 이후 유스케이스 작업이 엔티티 위에서 바로 시작됨. 불변식은 유스케이스와 함께 정의해야 제대로 테스트할 수 있어 행위 메서드는 미룸
  - `synchronize`를 쓰지 않으므로 엔티티와 SSOT 스키마가 어긋나도 런타임 전까지 알 수 없음 → 적합성 테스트를 유일한 안전망으로 둠
  - 테이블에 없는 컬럼을 베이스에서 상속하면 TypeORM이 SQL에 포함시켜 실패함(nullable로 해결 불가) → 시간 컬럼 구성별로 베이스 분리
  - 애그리거트 밖 관계를 객체로 매핑하면 경계가 흐려지고 의도치 않은 로딩이 생김
  - bigint를 number로 변환할 때 조용한 정밀도 손실은 금액 오류로 직결
- **변경 파일**: `src/common/domain/*`, `src/common/database/bigint-amount.transformer.ts`, `src/{service,billing-key,order,payment,ledger,outbox,pg-webhook,admin/audit}/{domain,constants}/*`, `src/pg/constants/pg.constants.ts`, `test/common/*`, `test/schema/*`, `test/setup/*`, `test/jest-integration.json`, `package.json`, `.env.example`, `db/schema.sql`, `CLAUDE.md`, `README.md`
- **스키마/에러 코드**: 스키마 구조 변경 없음 (주석만)
- **문서**: CLAUDE.md 8장 엔티티 규칙(베이스 클래스 선택, 컬럼 명시, 애그리거트 내부 관계, 순환 import 방지)과 테스트 규칙(통합 테스트·적합성 테스트) 갱신
- **남은 작업 / 주의**:
  - 엔티티가 아직 어떤 모듈의 `TypeOrmModule.forFeature()`에도 등록되지 않음 → 각 도메인 모듈을 만들 때 등록 (`autoLoadEntities`)
  - 통합 테스트는 Postgres가 필요 (`npm run db:up` 또는 `DB_*` 환경변수로 다른 인스턴스 지정)
  - 이번 검증은 로컬 PostgreSQL 18로 수행. `docker compose`(postgres:15) 경로는 미검증

#### chore: .gitignore에 node_modules 항목 추가
- **무엇을**: `.gitignore` 끝에 `node_modules` 추가
- **왜**: 의존성 디렉터리가 커밋되지 않도록 명시 (기존 `node_modules/` 규칙과 중복이며 동작 변화 없음)
- **변경 파일**: `.gitignore`

#### chore: NestJS 프로젝트 초기 세팅
- **무엇을**:
  - NestJS 11 프로젝트 뼈대: `package.json`, `tsconfig*.json`, `nest-cli.json`, ESLint 10(flat config, type-checked) + Prettier, `.editorconfig`, `.gitattributes`(LF 고정), `.gitignore`, `.env.example`
  - `src/main.ts`: 전역 prefix `/api/v1`, `ValidationPipe`(whitelist·forbidNonWhitelisted·transform), Swagger(`/docs`, production 제외), CORS 비활성, `initializeTransactionalContext()`
  - `src/app.module.ts`: ConfigModule(global), TypeORM(PostgreSQL, `autoLoadEntities`) + `typeorm-transactional` DataSource 등록, ScheduleModule
  - `docker-compose.yml`: postgres:15, 최초 기동 시 `db/schema.sql` 자동 적용
  - Jest 설정(`test/**/*.spec.ts`), 포트폴리오용 `README.md`
- **왜**:
  - 스키마 SSOT는 `db/schema.sql`이므로 TypeORM `synchronize`/`migrationsRun`을 끄고 엔티티가 스키마를 바꾸지 못하게 함
  - `@Transactional()`로 선기록(tx1) → 토스 호출 → 결과 반영(tx2) 흐름을 서비스 레이어에서 선언적으로 구성하기 위함
  - 서버 간 통신 전용이라 CORS 불필요. 알 수 없는 필드는 거부해 요청 계약을 엄격히 유지
  - `@nestjs/*` 최신 메이저는 12이지만 CLAUDE.md 스택(NestJS 11)에 맞춰 swagger 11 / config 4 / typeorm 11 / schedule 6으로 고정
- **변경 파일**: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `eslint.config.mjs`, `.prettierrc`, `.editorconfig`, `.gitattributes`, `.gitignore`, `.env.example`, `docker-compose.yml`, `src/main.ts`, `src/app.module.ts`, `src/common/config/database.config.ts`, `README.md`
- **남은 작업 / 주의**: 에러 코드·`BusinessException`·전역 예외 필터, 금액 bigint transformer, 기본 거부 전역 가드(`@ServiceApi`/`@AdminApi`/`@Public`)는 다음 커밋에서. 스키마 변경 후 로컬 DB는 `docker compose down -v`로 재생성 필요

#### docs: 설계 문서 및 DB 스키마 초기 반영
- **무엇을**: 개인 레포에 CLAUDE.md, CHANGELOG.md, DB 스키마를 최초 반영. `payment-hub.sql` → `db/schema.sql`로 이동, 헤더 주석의 구 명칭(`payment-ledger v2`)을 `payment-hub`로 정정
- **왜**: CLAUDE.md가 스키마 SSOT 경로를 `db/schema.sql`로 명시하고 있어 실제 위치를 문서와 일치시킴. 프로젝트명을 하나로 통일
- **변경 파일**: `db/schema.sql`, `CLAUDE.md`, `CHANGELOG.md`
- **남은 작업 / 주의**: 아래 항목들은 이 레포 이전의 설계 이력이며, 이 커밋에 함께 포함됨

#### docs(admin): 관리자 API 표면 및 감사 로그 설계 추가
- **무엇을**:
  - CLAUDE.md 6장 신설: 서비스 API(`/api/v1/*`)와 관리자 API(`/api/v1/admin/*`) 분리, admin 레포와의 호출 계약(admin 키 + `X-Admin-Actor-Id`), 서비스·키 관리 API, 전체 조회·운영 API, 서비스용 결제 이력 조회 API 정리
  - `tb_admin_audit_log` 테이블 추가 (append-only)
  - 가드 기본 거부 원칙(`@ServiceApi`/`@AdminApi`/`@Public` 필수), admin 전용 에러 코드 3개 추가
  - 이후 장 번호 한 칸씩 이동 (폴더 구조 7장 … 변경 이력 10장)
- **왜**:
  - 서비스 등록·키 발급·PG 키 등록은 별도 admin 레포에서 하므로 hub에 관리 전용 API와 호출 계약이 필요
  - 서비스는 결제 이력을 봐야 하지만 설정을 바꾸거나 다른 서비스 데이터를 보면 안 됨 → API 표면 자체를 분리하고 서비스 조회는 자기 데이터 읽기 전용
  - 관리자 작업은 결제에 직접 영향(수동 환불, 키 폐기)을 주므로 누가 언제 무엇을 왜 바꿨는지 추적 필요
  - admin 레포의 DB 직접 접근을 금지해 감사 로그와 도메인 규칙 우회를 차단
- **변경 파일**: `CLAUDE.md`, `db/schema.sql`
- **스키마/에러 코드**: `tb_admin_audit_log` 추가 / `ADMIN_ACTOR_REQUIRED`, `SERVICE_CODE_DUPLICATED`, `ADMIN_REASON_REQUIRED` 추가
- **남은 작업 / 주의**: AdminGuard, 전역 기본 거부 가드, 감사 로그 기록 헬퍼 구현. admin API 네트워크 제한(내부망/IP 허용 목록)은 인프라에서 설정 필요

#### docs: 에러 응답 한국어화 규칙 및 변경 이력 관리 규칙 추가
- **무엇을**: CLAUDE.md에 에러 처리 규칙(영문 코드 + 한국어 메시지, 전역 필터, 토스 에러 매핑, 기본 에러 코드 표)과 CHANGELOG 작성 규칙, 커밋 메시지 컨벤션 추가. CHANGELOG.md 생성
- **왜**: 연동 서비스가 에러 코드로 안정적으로 분기하면서도 사람이 바로 읽을 수 있는 메시지가 필요. 커밋 단위 작업 이유를 남겨 설계 의사결정 기록으로 활용
- **변경 파일**: `CLAUDE.md`, `CHANGELOG.md`
- **남은 작업 / 주의**: `common/errors/error-code.ts`, `BusinessException`, 전역 예외 필터 구현 필요

#### docs: 프로젝트 개요 및 설계 원칙 문서(CLAUDE.md) 작성
- **무엇을**: 문제 정의, 서비스와의 책임 경계, 설계 원칙 9가지, 스키마·상태 머신·원장 분개 규칙, 주요 흐름, 폴더 구조, 코딩 컨벤션 정리
- **왜**: v1에서 이벤트 큐가 서비스 비즈니스(서비스별 이벤트, 자동환불 정책)를 알게 되며 결합이 생긴 문제를 반복하지 않도록 원칙을 먼저 고정
- **변경 파일**: `CLAUDE.md`

#### schema: v2 DB 스키마 전면 재설계
- **무엇을**: 16개 테이블로 재구성
  - 서비스: `tb_service`, `tb_service_api_key`(다중 키), `tb_pg_credential`(서비스·환경별 토스 키, 암호화), `tb_service_product_type`(상품 유형 화이트리스트)
  - 주문·결제: `tb_order`, `tb_order_item`, `tb_payment`, `tb_payment_cancel`, `tb_payment_cancel_item`, `tb_billing_key`
  - 원장: `tb_ledger_account`, `tb_ledger_transaction`, `tb_ledger_entry` (복식부기, append-only, 차대 균형 트리거)
  - 이벤트: `tb_outbox_event`, `tb_webhook_delivery`, `tb_pg_webhook_event`
- **왜**:
  - v1은 `tb_service` 하나에 서비스 정보·인증·토스 키가 섞여 있었음 → 책임별 분리, 키 무중단 교체 가능
  - v1은 `product_type`을 검증 없이 저장 → 서비스별 화이트리스트 + 복합 FK로 검증
  - 서비스 간 자원 침범을 코드가 아닌 DB 복합 FK로 차단
  - 토스 호출 전 선기록(`IN_PROGRESS`)과 `UNKNOWN` 상태로 타임아웃 시 기록 누락 방지
  - 한 주문당 살아있는 결제 1건을 부분 유니크 인덱스로 강제 (이중 결제 방지)
  - 이벤트를 결제 사실만 담는 범용 이벤트로 바꾸고 전달 상태를 분리 (hub가 서비스 비즈니스를 모르도록)
  - 가상계좌 입금 반영을 위해 토스 웹훅 수신 테이블 추가
  - 매출·정산 집계 테이블 제거, 원장 엔트리에서 집계
  - 금액 bigint(최소 통화 단위), enum 대신 varchar + CHECK
- **변경 파일**: `db/schema.sql`
- **남은 작업 / 주의**: TypeORM 엔티티 작성. `sum(order_item.amount) = original_amount`, 환불 가능 금액 검증은 앱(엔티티 메서드)에서 강제해야 함
