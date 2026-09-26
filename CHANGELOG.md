# Changelog

이 프로젝트의 모든 변경 이력을 기록한다. 작성 규칙은 [CLAUDE.md 10장](./CLAUDE.md#10-변경-이력-관리-changelogmd) 참고.

## [Unreleased]

### 2026-09-27

#### feat(payment): 환불 대사 추가 — 결과 불명·멈춘 취소를 같은 멱등키로 토스에 재확인
- **무엇을**: `PaymentCancelService.resolvePending(cancelId)` — REQUESTED·UNKNOWN 취소를 원래와 같은 `Idempotency-Key`(`cancel:<paymentCancelId>`)·금액·사유로 토스에 다시 보내고 결과를 기존 반영 로직(결제·주문·원장·outbox)으로 확정. 여전히 모르면 `updated_at`만 갱신. `PaymentReconciler.reconcileCancelsDue()`(2분 이상 지난 것, 오래된 순), 대사 스케줄러가 결제 → 환불 순서로 실행. 토스 호출부를 `callToss`로 추출
- **왜**:
  - 결과 불명 환불이 풀리지 않으면 그 금액이 환불 가능 금액에서 영원히 빠져 있음
  - 결제 대사처럼 조회로 매칭하면 "어느 토스 취소가 이 요청인지"를 금액·시각으로 추측해야 함. 토스 멱등키 재사용은 "처리됐으면 원래 결과, 아니면 지금 처리"를 보장하므로 추측이 필요 없음 — 요청된 환불은 이미 검증을 통과한 것이라 늦게 처리돼도 맞는 결과
  - 한계: 가상계좌 환불 계좌는 저장하지 않으므로(개인정보) 토스에 도달하지 못한 가상계좌 환불은 대사에서 거절되고 금액이 풀림 → 서비스가 재요청
- **변경 파일**: `src/payment/{payment-cancel.service,payment-reconciler,payment-reconcile.scheduler}.ts`, `test/payment/cancel-reconcile.int-spec.ts`, `docs/api.md`, `README.md`

#### feat(outbox): 이벤트 재조회 API(GET /events) 추가
- **무엇을**:
  - `GET /events?after=<eventId>&limit=` — 자기 서비스 이벤트를 발행 순서 `(occurred_at, id)`대로, 웹훅 본문과 같은 형태로. `nextCursor`는 다음 조회의 `after`. 다른 서비스 eventId면 404
  - 발행 후 `EVENT_FEED_LAG_MS`(기본 5초)가 지난 이벤트만 반환
  - `PAYMENT_CANCELED`의 `occurredAt`을 토스 취소 시각 → **발행 시각**으로 변경 (토스 시각은 `data.cancel.canceledAt`에 유지)
  - 스키마: `ix_tb_outbox_event_service_feed (service_id, occurred_at, id)` 인덱스 추가
  - 예제 `listEvents`·`catchUpEvents(lastEventId, handle)`, api.md 3.6, 가이드, OpenAPI
- **왜**:
  - 웹훅이 DEAD가 되거나 서비스가 이벤트를 유실했을 때 서비스 스스로 복구할 경로
  - 발행 순서 커서는 "먼저 발행됐지만 늦게 커밋된" 이벤트를 건너뛸 수 있음 → 짧은 지연 창으로 완화 (별도 시퀀스 컬럼도 커밋 순서 문제는 같음)
  - 이벤트마다 occurredAt 기준이 다르면(취소만 토스 시각) 재조회 순서가 발행 순서와 어긋남
- **변경 파일**: `db/schema.sql`, `src/outbox/{event-feed.service,event-feed.controller,outbox.module,outbox.service}.ts`, `src/outbox/domain/outbox-event.entity.ts`, `examples/service-client.ts`, `test/outbox/*`, `test/docs/example-clients.int-spec.ts`, `docs/*`, `.env.example`
- **스키마/에러 코드**: 인덱스 1개 추가 (컬럼 변경 없음)
- **남은 작업 / 주의**: 트랜잭션이 지연 창(5초)보다 오래 걸리면 여전히 건너뛸 수 있음 — 웹훅이 1차 경로이고 재조회는 보조

#### feat(order): 주문 만료 배치 추가 (ORDER_EXPIRED 이벤트)
- **무엇을**: `OrderExpirer.expireDue()` — 만료 시각이 지난 PENDING 주문 중 살아있는 결제가 없는 것을 주문 행 락 + 재확인 후 `EXPIRED`로 바꾸고 `ORDER_EXPIRED` 이벤트(웹훅 전달 대상 포함) 발행. `Order.expire(now)`, `OutboxEvent.forOrder`, `OutboxService.publishOrderEvent`, `OrderExpiryScheduler`(기본 1분, `ORDER_EXPIRY_ENABLED`·`ORDER_EXPIRY_INTERVAL_MS`)
- **왜**:
  - 승인 시 만료 시각은 이미 검사하지만, 주문 상태가 PENDING으로 남아 서비스가 "결제 안 된 주문"을 정리할 신호가 없었음
  - 입금 대기(가상계좌 입금 기한이 주문 만료보다 길 수 있음)·결과 불명 결제가 있는 주문을 만료하면, 나중에 돈이 들어와도 주문을 PAID로 바꿀 수 없음 → 제외
  - 제외 조건을 후보 쿼리에 넣음: 건너뛴 주문이 오래된 순 배치의 앞자리를 계속 차지하면 뒤의 주문이 영원히 만료되지 않음
- **변경 파일**: `src/order/{order-expirer,order-expiry.scheduler,order.module}.ts`, `src/order/domain/order.entity.ts`, `src/outbox/{outbox.service.ts,domain/outbox-event.entity.ts}`, `test/order/*`, `test/outbox/outbox-event.entity.spec.ts`, `test/support/integration-app.ts`, `docs/api.md`, `.env.example`, `README.md`

#### feat(admin): 관리자 수동 환불 API(POST /admin/payments/:id/cancel) 추가
- **무엇을**:
  - 서비스 환불과 같은 유스케이스(`PaymentCancelService`)·규칙(환불 가능 금액 상한·항목·멱등·토스 결과 처리)에 `requestedBy = ADMIN`. 본문은 서비스 환불 + `reason`(필수)
  - 감사 로그 `PAYMENT_CANCELED_BY_ADMIN`(before: 상태·환불 누적, after: 취소 ID·금액·사유 코드, reason)을 **취소 요청을 기록하는 트랜잭션(tx1) 안에서** — `CancelPaymentCommand.onRequested` 훅 추가
  - admin 멱등키는 `admin:` 접두사로 저장 (최대 90자) → 서비스가 정한 환불 멱등키와 같은 문자열이어도 별개 환불
  - 사유가 없으면 `reasonDetail` 대신 토스 취소 사유로도 `reason` 사용
  - 예제 `examples/admin-client.ts`에 `cancelPayment`, api.md 2.5, admin 가이드 화면 매핑, README, OpenAPI 재생성
- **왜**:
  - CS 환불(서비스가 처리할 수 없는 경우)을 DB 직접 수정 없이 같은 도메인 규칙으로 처리 (CLAUDE.md 6.1)
  - 감사 로그를 tx1에서 남겨 "사유 없는 수동 환불"이 토스까지 가지 않음 — 사유가 없으면 취소 기록도 롤백되는 것을 테스트로 확인. 감사 로그 없는 관리 쓰기가 생기지 않음
  - 멱등키 접두사가 없으면 서비스와 admin이 우연히 같은 키를 쓸 때 서로의 환불을 "같은 요청"으로 오인 (접두사를 빼면 테스트가 409로 실패하는 것을 확인)
- **변경 파일**: `src/admin/payment/*`, `src/payment/{payment-cancel.service,payment.module}.ts`, `examples/admin-client.ts`, `test/admin/admin-payment-cancel.int-spec.ts`, `test/docs/example-clients.int-spec.ts`, `docs/*`, `README.md`
- **남은 작업 / 주의**: 환불 권한(예: 재무 권한만) 확인은 admin 레포 책임. 통합 테스트 전체 실행 10회 중 1회, 한 스위트(10건)가 실패했으나 재현·식별하지 못함 — 추적 필요

#### feat(admin): 운영 큐 API 추가 — 실패 웹훅 조회·재전송, 대사 대기 결제 조회·수동 대사
- **무엇을**:
  - `GET /admin/ops/webhook-deliveries` (`status`·`serviceId`, 최신순 cursor), `POST /admin/ops/webhook-deliveries/:id/redeliver` — 행 락 → `redeliver`(서비스의 현재 webhookUrl) → 저장 → 감사 로그 `WEBHOOK_REDELIVERED`(before/after). 이미 대기·전송 중이면 200·감사 로그 없음, webhookUrl이 없으면 `400`
  - `GET /admin/ops/unknown-payments` (IN_PROGRESS·UNKNOWN, 오래된 순), `POST /admin/ops/payments/:id/reconcile` — 토스 조회로 지금 확정, 응답 `{ resolved, payment }`. 확정했을 때만 감사 로그 `PAYMENT_RECONCILED`(before/after 상태)
  - `PaymentReconciler.reconcileOne(paymentId, onResolved)` — 경과 시간 조건 없이 한 건 대사, 확정 트랜잭션 안에서 훅 실행. `PaymentModule`이 reconciler를 export
  - 예제 `examples/admin-client.ts`에 운영 큐 4개, admin 가이드 화면 매핑·운영 절차(DEAD·UNKNOWN 처리 순서), api.md 2.5, OpenAPI 재생성
- **왜**:
  - 자동 처리(발송 재시도·대사 배치)가 결론을 못 낸 건을 사람이 처리할 수단. 지금까지 이 경우 "토스 상점관리자에서 확인"뿐이었음
  - 수동 대사의 감사 로그가 대사 확정과 같은 트랜잭션이어야 "감사 로그 없는 관리 쓰기"가 생기지 않음 — 감사 로그 기록을 실패시키면 결제 확정·원장도 롤백되는 것을 테스트로 확인
  - 확정 못 한 수동 대사는 상태를 바꾸지 않았으므로 감사 로그를 남기지 않음 (CLAUDE.md 6.5 멱등 규칙)
- **변경 파일**: `src/admin/ops/*`, `src/payment/{payment-reconciler,payment.module}.ts`, `src/app.module.ts`, `examples/admin-client.ts`, `test/admin/admin-ops.int-spec.ts`, `test/docs/example-clients.int-spec.ts`, `docs/*`

#### feat(outbox): 웹훅 관리자 재전송 규칙(redeliver) 도메인 추가
- **무엇을**: `WebhookDelivery.redeliver(now, targetUrl)` — DEAD·RETRYING·SUCCEEDED → `PENDING`(바로 보낼 수 있게), 받는 곳은 서비스의 **현재** webhookUrl, 시도 횟수 유지. PENDING·PROCESSING이면 바꾸지 않고 `false`(멱등). `auditSnapshot()` 추가
- **왜**:
  - DEAD의 흔한 원인이 webhookUrl 오류라, 발행 시점 URL 스냅샷으로 다시 보내면 소용이 없음 → admin이 URL을 고친 뒤 재전송하는 흐름
  - 시도 횟수를 유지해 재전송도 실패하면 곧바로 다시 DEAD (재전송이 무한 재시도로 번지지 않게)
  - 성공한 건도 재전송 허용: 서비스가 받은 뒤 처리 중 데이터를 잃은 경우 (서비스는 eventId로 멱등 처리)
- **변경 파일**: `src/outbox/domain/webhook-delivery.entity.ts`, `test/outbox/outbox-event.entity.spec.ts`

#### feat(admin): 전 서비스 결제 검색·결제 상세 API 추가
- **무엇을**:
  - `GET /admin/payments`: 서비스·상태(쉼표 여러 개)·수단·카드사·기간·사용자·서비스 주문번호·구독·**토스 paymentKey** 필터, 최신순 cursor 페이징. 항목에 `serviceId`·`providerPaymentKey` 추가
  - `GET /admin/payments/:id`: 결제 + 주문·항목 + 취소 이력 + 원장 분개(계정 코드·차대·금액, 사건 순) + 웹훅 전달 내역(이벤트·상태·시도·마지막 오류) + PG 응답 원본
  - 결제 검색 필터를 `payment/payment-search.ts`(`searchPayments`)로 추출해 서비스 API(`GET /payments`, serviceId는 인증값으로 고정)와 공유
  - 예제 `examples/admin-client.ts`에 `searchPayments`·`getPayment`, api.md 2.5, admin 가이드 화면 매핑, OpenAPI 재생성
- **왜**: CS·장애 대응 시 토스 대시보드의 paymentKey나 사용자 ID에서 출발해 hub의 기록(원장·웹훅 전달 여부·PG 원본)을 한 화면에서 볼 수 있어야 함. 이후 수동 대사·재전송·수동 환불 화면의 진입점. 필터 규칙을 한 곳에 두어 서비스·admin 검색이 어긋나지 않게 함
- **변경 파일**: `src/admin/payment/*`, `src/payment/{payment-search,payment.service}.ts`, `src/app.module.ts`, `examples/admin-client.ts`, `test/admin/admin-payment.int-spec.ts`, `test/docs/example-clients.int-spec.ts`, `docs/*`
- **남은 작업 / 주의**: PG 응답 원본은 관리자 응답에만 포함 (서비스 응답에는 없음). 조회는 감사 로그를 남기지 않음 (CLAUDE.md 6.5)

#### feat(payment): 환불 API(POST /payments/:id/cancel) 및 결제 단건 취소 이력 추가
- **무엇을**:
  - `POST /payments/:paymentId/cancel`: (tx1) 결제 행 락 → 멱등 재요청 확인 → 검증(`Payment.requestCancel`) → 취소 `REQUESTED`(+항목) 선기록 → 토스 취소(트랜잭션 밖, 멱등키 `cancel:<paymentCancelId>`) → (tx2) 취소 `DONE` + 결제 환불 누적·상태 + 주문 상태·항목 취소 수량 + 원장 `PAYMENT_CANCELED`(차 REFUND / 대 PG_RECEIVABLE) + outbox `PAYMENT_CANCELED`
  - 결과별: 토스 거절 → 취소 `FAILED` + `409 CANCEL_REJECTED`(`detail.pgCode·pgMessage`), 타임아웃·연결 실패 → `UNKNOWN` + `504 PG_TIMEOUT`, 5xx·이미 취소됨 → `UNKNOWN` + `502 PG_ERROR`. 에러는 tx2 커밋 뒤에 던짐
  - 멱등: `(서비스, idempotencyKey)` — 같은 내용(`PaymentCancel.matches`: 결제·금액·사유 코드·항목)이면 기록된 결과, 다르면 `409 CANCEL_IDEMPOTENCY_CONFLICT`, 처리 중이면 `409 CANCEL_IN_PROGRESS`
  - 가상계좌 결제는 `refundReceiveAccount` 필수 (토스에 전달만, 저장 안 함)
  - `GET /payments/:id` 응답에 `cancels`(취소 이력) 추가
  - `LedgerService.recordPaymentCanceled`, `OutboxService.publishPaymentCancelEvent`, `hubErrorForTossRejection`에 거절 코드 인자
  - 연동: `examples/service-client.ts`에 `cancelPayment`·`PaymentDetail`, 가이드 6장 환불 예제·에러 표, api.md 3.4·4장, OpenAPI 재생성
  - 테스트 가짜 토스의 취소 `transactionKey`를 전역 유일하게 (테스트 파일 간 유니크 충돌)
- **왜**:
  - 결제와 같은 "외부 호출 전 기록" 흐름으로 "환불은 됐는데 기록이 없는" 상태를 막음
  - 결제 행 락 + 처리 중 환불 차감: 동시 부분 환불 합계가 결제 금액을 넘지 않음. 락을 빼면 결정적 동시성 테스트가 실패하는 것을 확인
  - 토스 멱등키를 서비스 멱등키가 아니라 취소 건 ID로: 서비스 키가 바뀌어도 같은 취소 건은 토스에서 한 번만 처리됨
  - 환불 거절을 `PAYMENT_REJECTED`(결제 승인 거절)와 다른 코드로 — 서비스가 결제·환불 실패를 분기할 수 있게
- **변경 파일**: `src/payment/{payment-cancel.service,payment.controller,payment.service,payment.module}.ts`, `src/payment/dto/request/cancel-payment.request.dto.ts`, `src/payment/dto/response/payment-cancel.response.dto.ts`, `src/payment/domain/payment-cancel.entity.ts`, `src/ledger/ledger.service.ts`, `src/outbox/outbox.service.ts`, `src/pg/toss-error.ts`, `src/common/errors/error-code.ts`, `examples/service-client.ts`, `test/payment/*`, `test/docs/example-clients.int-spec.ts`, `test/support/fake-toss.ts`, `test/common/error-code.spec.ts`, `docs/*`, `CLAUDE.md`, `README.md`
- **스키마/에러 코드**: 스키마 변경 없음. `CANCEL_IDEMPOTENCY_CONFLICT`, `CANCEL_IN_PROGRESS`, `CANCEL_REJECTED`(모두 409) 추가
- **문서**: CLAUDE.md 8장 에러 코드 표 갱신
- **남은 작업 / 주의**: `UNKNOWN` 환불의 대사(토스 조회로 확정)는 아직 없음 — 그 금액은 확정 전까지 환불 가능 금액에서 빠진 채로 남음. admin 수동 환불(`POST /admin/payments/:id/cancel`)은 같은 도메인 로직으로 추가 예정

#### feat(pg): 토스 결제 취소(cancel) 추가
- **무엇을**: `TossPaymentsClient.cancel` — `POST /v1/payments/{paymentKey}/cancel { cancelReason, cancelAmount, refundReceiveAccount? }` + `Idempotency-Key`. 가상계좌 환불 계좌는 토스 형식(`bank`)으로 바꿔 전달만 함. `ALREADY_CANCELED_PAYMENT`는 `UNKNOWN`으로 분류. `TossPayment.cancels` 타입 추가
- **왜**: 환불 API의 토스 호출부. 재시도 시 같은 멱등키로 토스 쪽 중복 취소를 막고, "이미 취소됨"은 이전 요청이 성공했을 수 있으므로 실패로 확정하지 않음. 환불 계좌는 개인정보라 저장하지 않음
- **변경 파일**: `src/pg/{toss-payments.client,toss-payment.types}.ts`, `test/pg/toss-payments.client.spec.ts`

#### feat(ledger): 환불 반대 분개·환불 이벤트(PAYMENT_CANCELED) 도메인 추가
- **무엇을**: `LedgerTransaction.paymentCanceled(cancel, currency, accounts)` — 차) REFUND / 대) PG_RECEIVABLE, 취소 건 단위(`reference_type = PAYMENT_CANCEL`), 사건 시각은 토스 취소 시각. `OutboxEvent.forPaymentCancel` — 결제 요약(환불 누적 반영) + `cancel { paymentCancelId, amount, reasonCode, canceledAt }`
- **왜**: 원장은 append-only라 환불은 매출 행을 고치지 않고 반대 분개로 남김(CLAUDE.md 4장 분개 규칙). 취소 건 단위로 기장해 `(transaction_type, reference_type, reference_id)` 유니크가 부분 환불마다 한 번만 기장되게 보장. 서비스는 웹훅의 `cancel`로 어떤 환불 요청이 확정됐는지 알 수 있음
- **변경 파일**: `src/ledger/domain/ledger-transaction.entity.ts`, `src/outbox/domain/outbox-event.entity.ts`, `test/ledger/*`, `test/outbox/outbox-event.entity.spec.ts`

#### feat(payment): 환불 요청 검증·취소 확정 도메인 추가
- **무엇을**:
  - `Payment.requestCancel(request, orderItems)`: 취소 가능 상태(DONE·PARTIAL_CANCELED) 확인, 상한 = 환불 가능 금액 − **처리 중(REQUESTED·UNKNOWN) 취소 합계** → 넘으면 `CANCEL_AMOUNT_EXCEEDED`(`detail.refundableAmount`). 항목 검증(이 주문 항목인지, 중복, 취소 가능 수량 = 수량 − 취소된 − 처리 중, 항목 금액 합계 = 환불 금액)은 `INVALID_REQUEST` + 필드별 메시지. REQUESTED `PaymentCancel`(+항목)을 만들어 `cancels`에 붙임
  - `PaymentCancel.request/markDone/markFailed/markUnknown/isPending`, `PaymentCancelItem.create`
  - `Payment.applyCanceled(cancel)`: 환불 누적, 전액이면 `CANCELED` 아니면 `PARTIAL_CANCELED`
  - `Order.applyRefund(payment, items)`, `OrderItem.addCanceledQuantity(q)`: 주문 상태·항목 취소 수량 누적
- **왜**:
  - 환불 금액 검증은 DB가 강제하지 못하는 규칙 (CLAUDE.md 4장) → 엔티티가 책임
  - 토스 호출 중인 취소를 빼지 않으면, 동시에 들어온 부분 환불 둘이 각각 통과해 합계가 결제 금액을 넘을 수 있음 (확정 전이라 `refunded_amount`에 아직 없음). 이 규칙을 빼면 테스트가 실패하는 것을 확인
  - 실패한 취소는 금액을 잡아두지 않음 → 다시 요청 가능
  - 항목 금액 합계를 환불 금액과 맞추게 해 부분 환불 추적(`canceled_quantity`)과 금액이 어긋나지 않게 함. 금액 계산 자체(일할 등)는 여전히 서비스 책임
- **변경 파일**: `src/payment/domain/{payment,payment-cancel,payment-cancel-item}.entity.ts`, `src/order/domain/{order,order-item}.entity.ts`, `test/payment/payment-cancel.entity.spec.ts`
- **남은 작업 / 주의**: 원장 반대 분개·이벤트, 토스 취소 호출, API는 다음 커밋

#### feat(payment): 대사 배치 추가 — 결과 불명·멈춘 결제를 토스 조회로 확정
- **무엇을**:
  - `PaymentReconciler.reconcileDue()`: `IN_PROGRESS`·`UNKNOWN` 중 2분 이상 지난 결제(오래된 순 20건)를 토스 `getPayment`로 조회(트랜잭션 밖) → 결제 행 락 + 상태 재확인 후 반영. 토스 `DONE` → 주문 PAID·원장·`PAYMENT_CONFIRMED`, `ABORTED` → `FAILED`, `EXPIRED` → `EXPIRED`(둘 다 `PAYMENT_FAILED`)
  - 확정 못 한 건(토스도 승인 전, 404, 조회 타임아웃·5xx, 활성 토스 키 없음)은 `updated_at`만 갱신해 다음 대사 순서의 뒤로
  - 토스 응답이 결제 기록(paymentKey·orderId·금액)과 다르면 믿지 않고 `UNKNOWN` 유지 + 에러 로그
  - `EXPIRED` 결제도 `PAYMENT_FAILED` 이벤트, 같은 paymentKey 재승인 시 `402 PAYMENT_REJECTED`(`pgCode: EXPIRED`) — 이전에는 200으로 보일 수 있었음
  - `PaymentReconcileScheduler`(기본 1분, `RECONCILE_ENABLED`·`RECONCILE_INTERVAL_MS`). 주기 배치 공통부를 `common/scheduling/interval-job.ts`로 추출해 웹훅 발송 스케줄러와 공유
  - 문서: api.md 3.3(대사 규칙), 서비스 가이드 "결과를 모를 때", `.env.example`, CLAUDE.md 서비스 레이어 규칙
- **왜**:
  - 외부 호출 전 기록 원칙의 마무리. 타임아웃으로 `UNKNOWN`이 된 결제가 영원히 남으면 주문이 막히고(살아있는 결제 1건 제약) 실제로 승인된 돈이 매출에 잡히지 않음
  - 2분 이상 지난 건만: 토스 승인 타임아웃(30초) 동안 진행 중인 승인 요청과 대사가 같은 결제를 동시에 다루지 않게
  - 조회 결과가 기록과 다를 때 확정하면 다른 결제의 상태로 원장이 기장될 수 있음 — 사람이 보게 남김
  - 토스 404를 실패로 확정하지 않음: 다른 상점 키로 조회했을 가능성 등 "돈이 안 나갔다"를 확신할 수 없음
- **변경 파일**: `src/payment/{payment-reconciler,payment-reconcile.scheduler,payment-outcome.service,payment.service,payment.module}.ts`, `src/common/scheduling/interval-job.ts`, `src/outbox/webhook-dispatch.scheduler.ts`, `test/payment/payment-reconcile.int-spec.ts`, `test/support/integration-app.ts`, `docs/*`, `.env.example`, `CLAUDE.md`, `README.md`
- **문서**: CLAUDE.md 8장 서비스 레이어(결과 후속 기록 단일화, 주기 배치 규칙) 갱신
- **남은 작업 / 주의**: 오래 풀리지 않는 `UNKNOWN`을 보는 admin 운영 API(`/admin/ops/unknown-payments`, 수동 대사)는 아직 없음

#### refactor(payment): 결제 결과 후속 기록(주문·원장·outbox)을 PaymentOutcomeService로 분리
- **무엇을**: `PaymentService`의 결과 후속 기록을 `PaymentOutcomeService.record(payment, order)`로 옮김. 동작 변경 없음 (결제 통합 테스트 34개 그대로 통과)
- **왜**: 대사 배치도 같은 규칙(DONE → 주문 PAID·원장·PAYMENT_CONFIRMED …)으로 결과를 기록해야 함. 두 곳에 복사하면 규칙이 어긋남
- **변경 파일**: `src/payment/{payment.service,payment-outcome.service,payment.module}.ts`

#### feat(payment): 토스 결제 상태 ABORTED·EXPIRED 반영 규칙 추가
- **무엇을**: `Payment.applyTossPayment`가 토스 `ABORTED` → `FAILED`(토스 `failure.code·message` 보존), `EXPIRED` → `EXPIRED`로 확정. `READY`·`IN_PROGRESS` 등 승인 전 상태는 계속 `UNKNOWN`. `TossPayment.failure` 타입 추가
- **왜**: 대사가 토스 조회 결과로 결제를 확정하려면 실패·만료도 판단할 수 있어야 함. 실패·만료는 "돈이 나가지 않음"이 확정된 상태라 같은 주문으로 다시 결제할 수 있게 살아있는 결제에서 빠짐. 토스 `ABORTED`를 hub `ABORTED`가 아닌 `FAILED`로 두어 서비스가 볼 실패 상태를 하나로 유지
- **변경 파일**: `src/payment/domain/payment.entity.ts`, `src/pg/toss-payment.types.ts`, `test/payment/payment.entity.spec.ts`

#### feat(pg): 토스 결제 조회(getPayment) 추가
- **무엇을**: `TossPaymentsClient.getPayment({ secretKey, paymentKey })` — `GET /v1/payments/{paymentKey}`(URL 인코딩). 승인과 같은 결과 타입(200 → `APPROVED` + 현재 결제 상태, 4xx → `REJECTED`, 타임아웃·5xx → `UNKNOWN`). 내부 호출부를 `request(method, …)`로 일반화
- **왜**: 결과 불명(`UNKNOWN`)·멈춘(`IN_PROGRESS`) 결제를 토스의 실제 상태로 확정하는 대사 배치의 재료
- **변경 파일**: `src/pg/toss-payments.client.ts`, `test/pg/toss-payments.client.spec.ts`
- **남은 작업 / 주의**: 대사 배치는 다음 커밋

#### feat(outbox): 웹훅 발송 워커·스케줄러 추가
- **무엇을**:
  - `WebhookDispatcher.dispatchDue()`: (tx) `FOR UPDATE SKIP LOCKED`로 due 건 20개 획득·임대 → 서명 후 전송(트랜잭션 밖) → (tx) 결과 기록. 임대가 만료돼 다른 워커가 가져간 건(시도 횟수 불일치)은 덮어쓰지 않음
  - `WebhookSender`: 본문 `{ eventId, eventType, occurredAt, data }`, 서명 헤더, 타임아웃(`WEBHOOK_TIMEOUT_MS`, 기본 10초), 리다이렉트 안 따라감, 응답 본문 안 읽음
  - `WebhookDispatchScheduler`: `WEBHOOK_DISPATCH_INTERVAL_MS`(기본 1초)마다 실행, 배치가 가득 차면 비울 때까지 반복, 이전 틱 진행 중이면 건너뜀. `WEBHOOK_DISPATCH_ENABLED=false`로 끔
  - 서비스에 서명 키가 없으면 보내지 않고 실패로 기록 (서명 없는 결제 이벤트를 내보내지 않음)
  - 테스트: 가짜 서비스 수신 서버(`test/support/fake-webhook-receiver.ts`)로 서명을 **서비스용 예제 검증 코드로** 확인, 실패·재시도·연결 실패·임대 만료 재획득·워커 2개 동시 실행·서명 키 없음, 스케줄러 e2e. 통합 테스트 기본값은 스케줄러 꺼짐
  - 문서: api.md 4장·서비스 가이드 7장(재시도 간격·횟수·10초 응답 제한), admin 가이드 서명 키 교체 주의, `.env.example`
- **왜**:
  - 결제 응답과 후속 처리를 분리(웹훅 비동기)하는 설계의 나머지 절반. 서비스가 응답을 못 받은 경우에도 결과를 받을 수 있게 됨
  - 잠금 없이 획득하면 두 워커가 같은 건을 보냄 — 획득 구간을 겹치게 만든 테스트에서 잠금을 빼면 2번 전송되는 것을 확인
  - 서명은 이벤트 생성 시점이 아니라 전송 시점 키로 해야 서명 키 교체 후 재시도가 새 키로 검증됨
  - 리다이렉트를 따라가면 등록된 URL 밖으로 결제 이벤트가 나갈 수 있음
- **변경 파일**: `src/outbox/{webhook-dispatcher,webhook-sender,webhook-dispatch.scheduler,outbox.module}.ts`, `test/outbox/*`, `test/support/{fake-webhook-receiver,admin-fixtures,integration-app}.ts`, `docs/api.md`, `docs/guides/*`, `.env.example`, `README.md`
- **남은 작업 / 주의**: `DEAD` 조회·재전송 admin API, 이벤트 재조회 `GET /events`는 아직 없음

#### feat(outbox): 웹훅 전달 상태 전이(획득·성공·재시도 백오프·DEAD) 도메인 추가
- **무엇을**: `WebhookDelivery.claim/markSucceeded/markFailed`. 획득 시 `PROCESSING` + 시도 횟수 +1 + 임대(`locked_until`), 실패 시 1분 × 2^(n−1)(최대 1시간) 뒤 `RETRYING`, 10번째 실패면 `DEAD`. 에러 메시지 1000자 제한. 상수 `WEBHOOK_MAX_ATTEMPTS` 등
- **왜**:
  - 워커가 전송 중 죽어도 임대 만료 후 다른 워커가 다시 가져가야 함 (전달 누락 방지)
  - 획득 시 `next_attempt_at`을 임대 만료 시각으로 옮겨, 대기·재시도·임대 만료 건을 `status IN (...) AND next_attempt_at <= now` 조건 하나(기존 `ix_tb_webhook_delivery_due` 인덱스)로 찾게 함
  - 서비스 장애가 길어져도 재시도가 폭주하지 않게 지수 백오프, 무한 재시도 대신 한도 후 `DEAD` → 운영자가 원인 해결 후 재전송
- **변경 파일**: `src/outbox/domain/webhook-delivery.entity.ts`, `src/outbox/constants/outbox.constants.ts`, `test/outbox/outbox-event.entity.spec.ts`
- **남은 작업 / 주의**: 실제 발송 워커는 다음 커밋

#### feat(payment): 결제 승인 API(토스 연동·원장 기장·outbox) 및 결제 조회·환불 가능 금액 API 추가
- **무엇을**:
  - `POST /payments/confirm`: (tx1) 주문 행 락 → paymentKey 재요청·살아있는 결제 확인 → 주문 검증(상태·만료·금액) → 결제 `IN_PROGRESS` 선기록 → 토스 승인(트랜잭션 밖) → (tx2) 결과 반영 + 주문 `PAID` + 원장 `PAYMENT_CAPTURED`(차 PG_RECEIVABLE / 대 REVENUE) + outbox 이벤트·웹훅 전달 대상(`PENDING`, URL 스냅샷)
  - 결과별 처리: 승인 `DONE` / 가상계좌 `WAITING_FOR_DEPOSIT`(원장 없음, 입금 대기 이벤트) / 토스 거절 `FAILED` + `402 PAYMENT_REJECTED`(`detail.pgCode·pgMessage`) / 타임아웃·연결 실패 `UNKNOWN` + `504 PG_TIMEOUT` / 5xx·`ALREADY_PROCESSED_PAYMENT` `UNKNOWN` + `502 PG_ERROR` / 토스 키 인증 실패 `FAILED` + `502 PG_ERROR`
  - 같은 paymentKey 재요청은 토스를 다시 부르지 않고 기록된 결과(성공·실패)를 반환. 멱등키 = `confirm:` + sha256(paymentKey) (토스 `Idempotency-Key`로도 전달)
  - `TossPaymentsClient`(`src/pg/`): Basic 인증, `Idempotency-Key`, `AbortSignal.timeout`. 예외 대신 `APPROVED`/`REJECTED`/`UNKNOWN` 결과 반환. env `TOSS_API_BASE_URL`, `TOSS_API_TIMEOUT_MS`(기본 30초)
  - 결제 수단 분류 `Payment.applyTossPayment`: 토스 method 원문(한·영) → `methodType`, 카드 종류 `신용/체크/기프트` → `CREDIT/CHECK/GIFT/UNKNOWN`, 카드사·은행·간편결제사·가상계좌 정보. 모르는 수단은 `null` + 원문 보존
  - 도메인: `Payment.startConfirm/applyTossPayment/markFailed/markUnknown/refundableAmount`, `Order.assertConfirmable/markPaid`, `LedgerTransaction.paymentCaptured`, `LedgerEntry.create`, `OutboxEvent.forPayment`, `WebhookDelivery.pending`
  - 원장 계정은 서비스·코드·통화별로 첫 기장 때 생성 (`INSERT ... ON CONFLICT DO NOTHING`), 계정 코드 상수 `LedgerAccountCode`
  - `GET /payments/:id`(수단 분류·환불 가능 금액·실패 사유), `GET /payments`(사용자별 이력 — externalUserId·externalOrderId·externalSubscriptionId·상태 쉼표 다중·수단·기간, cursor 페이징, 실패 시도 포함), `GET /payments/:id/refundable`(상한·항목별 취소 가능 수량). 다른 서비스 결제는 `404 PAYMENT_NOT_FOUND`
  - 연동: `examples/service-client.ts`에 `confirmPayment/getPayment/listPayments/getRefundable` (confirm 타임아웃 60초), 가이드 5.3 결과별 분기 코드·결과 불명 시 확인 절차·5.5 조회, api.md 3.3·4장, OpenAPI 재생성
  - 테스트 지원: `test/support/fake-toss.ts`(실제 HTTP 가짜 토스), `onboardPayableService` 픽스처, `createIntegrationApp(env)`
- **왜**:
  - 외부 호출 전 기록 원칙: 토스 호출 전에 `IN_PROGRESS`를 커밋해 "돈은 나갔는데 기록이 없는" 상태를 만들지 않음. 결과를 모르면 실패로 확정하지 않고 `UNKNOWN`으로 둠 (실패로 두면 사용자가 재결제해 이중 결제 위험)
  - 에러 응답은 tx2 커밋 뒤에 던짐 — 트랜잭션 안에서 던지면 `FAILED`/`UNKNOWN` 기록이 롤백됨
  - 주문 행 락: 같은 주문의 동시 승인 요청을 직렬화해 토스 승인이 한 번만 일어나게 함. HTTP 동시 요청 테스트는 락을 빼도 통과해서(요청이 실제로 겹치지 않음), 트랜잭션 안 조회를 늦춘 결정적 테스트를 추가하고 락을 빼면 실패(500, 유니크 위반)하는 것을 확인
  - 토스 거절을 `PG_ERROR`(502)가 아닌 별도 코드로: 사용자 카드 문제(다른 수단으로 재시도 가능)와 hub·토스 장애(재시도 금지)를 서비스가 `code`만으로 구분할 수 있어야 함. 402는 결제 거절 관례(Payment Required)
  - `ALREADY_PROCESSED_PAYMENT`는 이전 승인이 성공했을 수 있으므로 실패가 아니라 `UNKNOWN`
  - 가짜 토스를 목이 아닌 실제 HTTP 서버로: 인증 헤더·타임아웃·비JSON 응답 분류까지 실제 코드 경로로 검증
  - 예제의 기본 타임아웃(10초)이 hub의 토스 대기(30초)보다 짧으면 서비스가 먼저 끊고 결과를 모르게 됨 → confirm만 60초
- **변경 파일**: `src/payment/*`, `src/pg/*`, `src/ledger/{ledger.service,ledger.module}.ts`, `src/ledger/domain/*`, `src/ledger/constants/ledger.constants.ts`, `src/outbox/{outbox.service,outbox.module}.ts`, `src/outbox/domain/*`, `src/outbox/constants/outbox.constants.ts`, `src/order/domain/order.entity.ts`, `src/common/errors/error-code.ts`, `src/app.module.ts`, `examples/{http,service-client}.ts`, `test/payment/*`, `test/pg/*`, `test/ledger/*`, `test/outbox/*`, `test/order/order.entity.spec.ts`, `test/docs/example-clients.int-spec.ts`, `test/support/*`, `test/common/error-code.spec.ts`, `docs/*`, `.env.example`, `CLAUDE.md`, `README.md`
- **스키마/에러 코드**: 스키마 변경 없음. `PAYMENT_REJECTED`(402) 추가
- **문서**: CLAUDE.md 8장 에러 코드 표·토스 에러 매핑 규칙·서비스 레이어(토스 결과 타입, 주문 행 락)·테스트(가짜 토스, 결정적 동시성 테스트) 갱신
- **남은 작업 / 주의**:
  - `UNKNOWN`·오래된 `IN_PROGRESS` 결제를 확정할 대사 배치(토스 조회 API)와 admin 수동 대사는 아직 없음 — 그 전까지 결과 불명 결제는 운영자가 토스 상점관리자에서 확인
  - 웹훅은 이벤트·전달 대상만 기록되고 실제 발송(폴러)은 다음 단계. 가상계좌 입금(토스 웹훅 수신)도 다음 단계
  - 토스 실제 API로는 호출해 보지 않음 (가짜 서버로 토스 공식 문서 규격을 재현). `npm run local:onboard`에 토스 테스트 키를 넣으면 실제 테스트 결제로 확인 가능

#### docs: 서비스·admin 연동 가이드, OpenAPI 스펙, 테스트된 예제 코드, 로컬 온보딩 도구 추가
- **무엇을**:
  - 연동 가이드: `docs/guides/service-integration.md`(받을 값, 호출·재시도 규칙, 결제 흐름, 토스 결제창, 웹훅 수신 구현, 에러 코드별 대응, 운영 체크리스트), `docs/guides/admin-integration.md`(책임 경계, admin 키 발급·교체, 헤더·감사 로그·사유, 온보딩 4단계, 화면별 API 매핑, 키·PG·서명 키 교체 절차)
  - `docs/openapi.json`: DB 없이(Nest preview 모드) 코드에서 생성. `npm run openapi:export`, 코드와 다르면 `test/docs/openapi.spec.ts` 실패. Swagger 설정을 `src/openapi.ts`로 모아 `/docs`와 공유
  - 웹훅 서명 규격 구현 `src/outbox/webhook-signature.ts` (`v1=HMAC-SHA256(secret, "<ts>.<body>")`) + 서비스용 검증 예제 `examples/webhook-signature-verify.ts` (재전송 5분 제한, timingSafeEqual). 둘이 맞는지 테스트
  - 예제 클라이언트 `examples/{http,service-client,admin-client}.ts` (내장 fetch만) — 실제 HTTP로 띄운 hub에 붙여 온보딩·주문·에러 분기·정지·키 교체 흐름 검증
  - 스크립트 `npm run admin-key:generate`(평문 키 + hub용 해시), `npm run local:onboard`(서비스·상품 유형·토스 테스트 키·API 키 준비, 재실행 시 서비스 재사용, 발급 키로 실제 호출 확인 후 서비스 .env 값 출력)
  - 웹훅 URL 정책: TEST 배포는 로컬 개발용 `http`(localhost 포함) 허용, LIVE 배포는 https만 (`webhook-url.policy.ts`). 검증 메시지 `httpsUrl` → `httpUrl`
  - `tsconfig.build.json`에서 `scripts/`, `examples/` 제외 (빌드 산출물 구조 유지), lint·format 대상에 포함
- **왜**:
  - 서비스·admin 레포를 이 레포와 문서만 보고 연동할 수 있어야 함. 문서의 코드가 틀리면 연동이 막히므로, 가이드가 싣는 예제·서명 검증 코드를 실제 hub에 붙여 테스트해 "문서가 틀릴 수 없게" 함
  - OpenAPI 파일을 손으로 관리하면 코드와 어긋남 → 코드에서 생성하고 불일치를 테스트로 잡음. 연동 쪽이 클라이언트를 생성할 수 있음
  - 웹훅 발송은 아직 없지만 서비스가 수신부를 먼저 만들 수 있도록 서명 규격과 검증 코드를 먼저 확정
  - https만 허용하면 서비스 개발자가 로컬 수신 서버로 연동 테스트를 할 수 없음. 운영(LIVE)은 결제 이벤트 평문 전송을 막기 위해 https 유지
  - 로컬 온보딩도 관리자 API만 사용 (DB 직접 수정 금지 원칙, 감사 로그가 남음)
- **변경 파일**: `docs/guides/*`, `docs/openapi.json`, `docs/api.md`, `examples/*`, `scripts/*`, `src/openapi.ts`, `src/main.ts`, `src/app.setup.ts`, `src/outbox/webhook-signature.ts`, `src/admin/service/{webhook-url.policy,admin-service.service}.ts`, `src/admin/service/dto/request/{create,update}-service.request.dto.ts`, `src/common/utils/validation-message.util.ts`, `test/docs/*`, `test/admin/*`, `test/common/validation-message.util.spec.ts`, `package.json`, `tsconfig.build.json`, `CLAUDE.md`, `README.md`
- **문서**: CLAUDE.md 7장(레포 루트 구조), 6.2(웹훅 URL 환경별 규칙), 9장(연동 문서 동기화 규칙) 갱신
- **남은 작업 / 주의**:
  - 가이드의 🚧 항목(결제 승인·환불·빌링·웹훅 발송·이벤트 재조회)은 구현 시 상태와 예제를 갱신
  - 예제 클라이언트는 구현된 API만 포함. 결제 API 구현 시 `examples/service-client.ts`에 추가하고 `test/docs`에서 검증

#### feat(order): 주문 사전 등록·조회 API 추가
- **무엇을**:
  - `Order.create`: 주문 ID 생성, 항목(순번·단가×수량) 생성, `sum(항목) = 원금`, `원금 − 할인 = 결제 금액 > 0`, 안전 정수 범위 검증 → 실패 시 `ORDER_AMOUNT_INVALID` + 계산값 detail
  - `Order.matches`: 멱등 재요청 비교 (사용자·구독·주문명·통화·항목·할인·금액·metadata, metadata는 키 순서 무관). 만료 시각은 비교 제외
  - `POST /api/v1/orders`: 활성 상품 유형만 허용(`PRODUCT_TYPE_NOT_ALLOWED` + 거부된 코드 목록), 새 주문 `201` / 같은 요청 재시도 `200` / 내용 다르면 `409 ORDER_IDEMPOTENCY_CONFLICT`
  - `GET /api/v1/orders/:orderId`(항목 포함, 타 서비스 `404 ORDER_NOT_FOUND`), `GET /api/v1/orders`(요약 목록, 필터 + cursor 페이징)
  - cursor 페이징을 `paginateByCreatedAt()`으로 추출해 관리자 서비스 목록과 공유
- **왜**:
  - 결제 금액을 결제 전에 서버 간 호출로 고정해야 confirm 시 클라이언트 금액 변조를 막을 수 있음 (CLAUDE.md 5장)
  - `sum(order_item.amount) = original_amount`는 DB가 강제하지 못하므로 엔티티 팩토리에서 강제 (4장 "앱이 지켜야 하는 규칙")
  - 상품 유형 FK는 존재만 강제하고 중지 여부는 모르므로 앱이 활성 여부를 확인
  - 서비스 서버는 네트워크 오류 시 주문 등록을 재시도하므로 같은 요청은 같은 결과여야 함. 사전 조회와 저장 사이의 경합은 유니크 위반을 **실패한 트랜잭션 밖에서** 다시 읽어 멱등 응답으로 바꿈. 경합 경로는 HTTP 동시 요청으로는 재현이 불안정해 조회를 한 번 가로채는 결정적 테스트로 검증
  - 재시도마다 만료 시각이 늘어나면 안 되므로 만료는 비교 대상에서 제외하고 최초 값을 유지
- **변경 파일**: `src/order/**`, `src/common/database/cursor-pagination.ts`, `src/admin/service/admin-service.service.ts`, `src/app.module.ts`, `test/order/**`, `docs/api.md`, `README.md`
- **스키마/에러 코드**: 변경 없음
- **남은 작업 / 주의**: 만료 배치(`PENDING → EXPIRED`, `ORDER_EXPIRED` 이벤트)와 주문 단건의 결제 정보는 결제 구현 시

#### feat(admin): PG 자격증명·상품 유형 관리 API 및 결제창 설정 조회 추가
- **무엇을**:
  - `PgCredential.register`(시크릿 키는 암호화 함수로만 넘기고 암호문·끝 4자리만 보관, 키 prefix `test_`/`live_`와 환경 불일치 시 `INVALID_REQUEST`), `deactivate`(멱등), `auditSnapshot`
  - `ServiceProductType.create`, `update`(이름·isActive, 바뀐 필드 반환), `auditSnapshot`
  - 관리자 API: `POST/GET /admin/services/:id/pg-credentials`, `POST /admin/pg-credentials/:id/deactivate`(사유 필수), `POST/GET /admin/services/:id/product-types`, `PATCH .../product-types/:code`
  - 서비스 API: `GET /api/v1/pg/client-config` — 이 배포 환경의 활성 `clientKey`
  - 에러 코드 `PRODUCT_TYPE_DUPLICATED`(409) 추가
  - 서비스 행 락 조회를 `lockActiveService()`로 추출해 서비스·키·PG·상품 유형 관리가 공유
  - 테스트 픽스처 `test/support/admin-fixtures.ts`
- **왜**:
  - 새 서비스 연동 절차(서비스 등록 → API 키 → 상품 유형 → PG 자격증명)를 API로 완성해야 주문·결제로 넘어갈 수 있음
  - 토스 키는 prefix로 환경이 구분되므로, 운영 키가 테스트 설정에(또는 반대로) 들어가는 사고를 등록 시점에 차단. 검증은 엔티티 불변식으로 둬 우회 불가
  - 활성 키는 (서비스, 환경)당 1개(부분 유니크 인덱스) → 새 키 등록 시 기존 키를 같은 트랜잭션에서 먼저 끄고, 교체 사실은 등록 감사 로그 `before`에 남김. 자동 비활성은 관리자가 직접 한 비활성과 달리 사유를 받지 않음
  - 상품 유형은 기존 주문 항목이 FK로 참조하므로 삭제 대신 중지. 복합 PK라 감사 로그 target은 `<serviceId>:<code>`
  - 결제창용 공개 키를 서비스가 따로 보관하지 않도록 hub가 제공 (키 교체가 hub 한 곳에서 끝남)
- **변경 파일**: `src/service/domain/{pg-credential,service-product-type}.entity.ts`, `src/service/{service.service,service.controller}.ts`, `src/service/dto/response/pg-client-config.response.dto.ts`, `src/admin/service/{admin-pg-credential,admin-product-type}.{service,controller}.ts`, `src/admin/service/service-lock.ts`, `src/admin/service/admin-service.{service,module}.ts`, `src/admin/service/dto/**`, `src/common/errors/error-code.ts`, `test/**`, `docs/api.md`, `CLAUDE.md`, `README.md`
- **스키마/에러 코드**: `PRODUCT_TYPE_DUPLICATED` 추가 (스키마 변경 없음)
- **문서**: CLAUDE.md 에러 코드 표 갱신, `docs/api.md` 2.3·2.4·3.1 ✅
- **남은 작업 / 주의**:
  - PG 자격증명 등록 시 토스 API로 키가 실제로 유효한지 확인하지 않음 → PG 클라이언트 구현 후 추가 검토
  - `error-code.ts`는 현재 26개로 한 파일 유지. 도메인당 10개를 넘기 시작하면 도메인별 정의 파일 + 중복 코드명 검사 테스트로 분리

### 2026-09-26

#### feat(admin): 서비스·API 키 관리 API 및 서비스 API 키 인증(ApiKeyGuard) 추가
- **무엇을**:
  - 관리자 API: `POST/GET /admin/services`, `GET/PATCH/DELETE /admin/services/:id`, `POST .../suspend`, `.../resume`, `.../webhook-secret/rotate`, `POST/GET .../api-keys`, `POST /admin/api-keys/:id/revoke`
  - 서비스 등록 시 웹훅 서명 키(`whsec_…`) 자동 발급 → 암호화 저장, 평문은 등록·교체 응답에서 1회만
  - `AdminAuditService`: 모든 관리 쓰기를 같은 `@Transactional()`에서 기록. 대상 행 `pessimistic_write` 락으로 동시 관리 작업 직렬화
  - `ApiKeyGuard`: SHA-256 해시 조회 → 폐기/만료/서비스 삭제/정지 거부 → `req.serviceId`, `last_used_at` 비동기 갱신. 전역 `AuthGuard`가 `@ServiceApi`를 위임
  - `GET /api/v1/me`: 서비스가 자기 키로 연결·인증 상태를 확인하는 첫 서비스 API
  - `CryptoModule`(전역 `EncryptionService`), `PG_ENVIRONMENT` 검증(`TEST`/`LIVE` 외 값이면 부팅 실패, 미설정 시 TEST), 유니크 위반 판별 유틸, `@CurrentAdminActor`/`@CurrentServiceId`
  - 통합 테스트 인프라 `test/support/integration-app.ts` (실제 AppModule + 테스트 DB)
- **왜**:
  - 서비스가 hub를 호출하려면 "서비스 등록 → 키 발급 → 키 인증"이 먼저 있어야 함 (새 서비스 연동 절차의 첫 두 단계)
  - 감사 로그와 관리 쓰기를 한 트랜잭션에 묶어 "기록 없는 변경"을 원천 차단. 감사 로그 기록 실패 시 상태 변경 롤백을 테스트로 확인
  - 코드 중복은 사전 조회로 막고, 사이에 끼어든 동시 등록은 DB 유니크 위반을 잡아 같은 에러 코드로 변환
  - 삭제된 서비스의 키는 401(존재 숨김), 정지는 403으로 구분해 서비스가 원인을 알 수 있게 함
  - `last_used_at`은 키 교체 절차(구 키 사용 중단 확인)에 쓰이지만 응답을 늦출 이유는 없어 비동기
  - LIVE 오타가 조용히 TEST 키 prefix로 바뀌지 않도록 환경 값은 부팅 시 검증
- **변경 파일**: `src/admin/service/**`, `src/admin/audit/{admin-audit.service,admin-audit.module}.ts`, `src/service/{api-key.guard,service.controller,service.service,service.module}.ts`, `src/service/dto/**`, `src/common/{crypto/crypto.module,config/pg-environment.config,database/unique-violation,decorators/current-actor.decorator}.ts`, `src/common/guards/{auth.guard,auth.module}.ts`, `src/app.module.ts`, `test/admin/admin-service.int-spec.ts`, `test/service/api-key-auth.int-spec.ts`, `test/support/integration-app.ts`, `test/common/auth-guard.spec.ts`, `docs/api.md`, `CLAUDE.md`, `README.md`, `.env.example`
- **스키마/에러 코드**: 변경 없음
- **문서**: CLAUDE.md 설계 원칙 8(암호화 키링), 6.5(관리 쓰기 순서·멱등 재요청은 감사 로그 없음), 8장 인증(ApiKeyGuard 거부 순서, 파라미터 데코레이터). `docs/api.md` 2.1·2.2 ✅, 3.0 `GET /me` 추가
- **남은 작업 / 주의**:
  - `.env`에 `ENCRYPTION_KEYS`가 없으면 부팅 실패 (README 실행 방법에 생성 명령 추가)
  - 인증 가드 단위 테스트는 ApiKeyGuard를 대역으로 바꾸고 위임만 검증. 실제 키 검증은 통합 테스트가 담당
  - 서비스 상세의 키·PG·상품 유형 요약은 PG 자격증명·상품 유형 API 구현 시

#### feat(service): 서비스·API 키 도메인 행위 및 공통 기반(암호화·응답 래퍼·검증 메시지·cursor) 추가
- **무엇을**:
  - `EncryptionService`: AES-256-GCM + 버전 키링(`v1:<base64>,v2:...`). 암호문 `iv|tag|ciphertext`, 키 ID 함께 반환. 설정 오류(빈 키링, 32바이트 아님, 중복 ID, 현재 키 ID 없음)는 생성 시 실패
  - `ResponseInterceptor` + `@ResponseMessage()`: 성공 응답 `{ success: true, message, data }`. `IResponseBase`/`IPageable` 타입
  - `ValidationMessage`: 한국어 검증 메시지 공통 함수. 영문 필드명도 읽는 소리에 맞춰 은/는 선택
  - cursor 페이징 인코딩/디코딩 (`(createdAt, id)` → base64url), 깨진 cursor는 `400 INVALID_REQUEST`
  - `Service`: `create`, `update`(바뀐 필드 반환), `suspend`/`resume`(멱등, 변경 여부 반환), `delete`(soft), `rotateWebhookSecret`, `auditSnapshot`. 삭제된 서비스에 대한 모든 행위는 `RESOURCE_NOT_FOUND`
  - `ServiceApiKey`: `issue`(환경별 `ph_test_`/`ph_live_` + 32바이트 랜덤, 평문은 반환값으로 1회, 엔티티엔 SHA-256만), `hash`, `revoke`(멱등, 최초 시각 유지), `isExpired`, `auditSnapshot`
  - `AdminAuditLog.record`: 사유 필수 작업(`SERVICE_SUSPENDED`, `SERVICE_DELETED`, `PG_CREDENTIAL_DEACTIVATED`, `PAYMENT_CANCELED_BY_ADMIN`)은 사유 없으면 `ADMIN_REASON_REQUIRED`
  - 테스트 헬퍼 `expectBusinessError`
- **왜**:
  - 관리자 API 구현 전에 도메인 규칙을 DB 없이 단위 테스트로 고정 (CLAUDE.md 설계 원칙 9)
  - 정지·재개·폐기를 멱등으로 두어 admin 레포 재시도가 에러가 되지 않게 하고, 변경 여부로 감사 로그 중복 기록을 막음
  - 감사 로그 사유 검증을 엔티티에 두면 어떤 경로로 기록하든 우회할 수 없음
  - 암호화 키에 버전을 붙여 키 교체 후에도 이전 암호문 복호화 가능
- **변경 파일**: `src/common/crypto/encryption.service.ts`, `src/common/interceptors/response.interceptor.ts`, `src/common/decorators/response-message.decorator.ts`, `src/common/utils/{validation-message,cursor}.util.ts`, `src/app.setup.ts`, `src/service/domain/{service,service-api-key}.entity.ts`, `src/admin/audit/**`, `test/**`, `CLAUDE.md`
- **남은 작업 / 주의**: `EncryptionService`의 Nest 모듈 등록과 env(`ENCRYPTION_KEYS`, `ENCRYPTION_KEY_ID`)는 관리자 API 커밋에서

#### feat(auth): 기본 거부 전역 가드 및 관리자 인증(AdminGuard) 추가
- **무엇을**:
  - `@Public()` / `@ServiceApi()` / `@AdminApi()` 데코레이터 (컨트롤러·핸들러 모두 가능, 핸들러 우선)
  - 전역 `AuthGuard`(`APP_GUARD`): 데코레이터 없는 핸들러는 `401 UNAUTHORIZED` + 핸들러 이름 에러 로그
  - `AdminGuard`: `Authorization: Bearer <admin_key>`를 SHA-256 해시로 `ADMIN_API_KEY_HASHES`와 `timingSafeEqual` 비교, `X-Admin-Actor-Id` 필수(`400 ADMIN_ACTOR_REQUIRED`), `X-Admin-Actor-Name` URL 디코딩, 관리자 헤더 100자 초과 `400 INVALID_REQUEST`, `req.adminActor` 설정
  - `ADMIN_API_KEY_HASHES`에 잘못된 값이 있으면 부팅 실패, 비어 있으면 관리자 요청 전부 거부
  - `req.serviceId` / `req.adminActor` 타입 확장, Bearer 토큰 추출 유틸
- **왜**:
  - 인증 누락은 조용히 열린 API가 되므로 "붙이는 걸 잊으면 막히는" 기본 거부 구조로 둠
  - admin API는 actor 헤더를 신뢰하므로 키 검증이 유일한 관문 → 해시 비교 + 타이밍 공격 방지
  - 설정 오타로 admin 키가 조용히 무시되면 장애 원인 파악이 어려움 → 부팅 시점에 실패
  - actor 헤더는 감사 로그 컬럼(100자)에 들어가므로 입구에서 막지 않으면 쓰기 시점에 500이 됨
- **변경 파일**: `src/common/decorators/auth.decorator.ts`, `src/common/guards/*`, `src/common/types/request-context.ts`, `src/app.module.ts`, `test/common/auth-guard.spec.ts`, `CLAUDE.md`, `docs/api.md`, `README.md`
- **문서**: CLAUDE.md 8장 인증에 가드 구조·설정 검증·헤더 길이 규칙 추가
- **남은 작업 / 주의**:
  - `ApiKeyGuard`(서비스 API 키 DB 조회, revoked/expired/SUSPENDED/삭제 거부, `last_used_at` 비동기 갱신)는 다음 커밋. **그 전까지 `@ServiceApi` 핸들러는 전부 401**
  - 부팅 시 모든 라우트에 데코레이터가 있는지 검사하는 기능은 없음 (현재는 요청 시점에 거부 + 로그)

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
