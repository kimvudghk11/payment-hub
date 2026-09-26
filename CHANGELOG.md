# Changelog

이 프로젝트의 모든 변경 이력을 기록한다. 작성 규칙은 [CLAUDE.md 10장](./CLAUDE.md#10-변경-이력-관리-changelogmd) 참고.

## [Unreleased]

### 2026-09-26

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
