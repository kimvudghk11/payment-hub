/**
 * 에러 코드의 단일 진실 공급원.
 * 코드(키)는 서비스가 분기에 쓰는 안정적인 식별자이므로 한 번 공개하면 이름을 바꾸지 않는다.
 * 추가 시 CLAUDE.md 8장 "기본 에러 코드" 표도 함께 갱신한다.
 */
const ERROR_DEFINITIONS = {
  // 공통
  INVALID_REQUEST: { status: 400, message: '요청 값이 올바르지 않습니다.' },
  UNAUTHORIZED: { status: 401, message: '인증 정보가 없거나 올바르지 않습니다.' },
  API_KEY_EXPIRED: { status: 401, message: '만료된 API 키입니다.' },
  API_KEY_REVOKED: { status: 401, message: '폐기된 API 키입니다.' },
  SERVICE_SUSPENDED: { status: 403, message: '이용이 중지된 서비스입니다.' },
  RESOURCE_NOT_FOUND: { status: 404, message: '요청한 리소스를 찾을 수 없습니다.' },
  INTERNAL_ERROR: { status: 500, message: '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' },

  // 관리자
  ADMIN_ACTOR_REQUIRED: { status: 400, message: '관리자 식별 정보(X-Admin-Actor-Id)가 필요합니다.' },
  SERVICE_CODE_DUPLICATED: { status: 409, message: '이미 사용 중인 서비스 코드입니다.' },
  ADMIN_REASON_REQUIRED: { status: 400, message: '이 작업에는 사유 입력이 필요합니다.' },

  // 주문
  PRODUCT_TYPE_NOT_ALLOWED: { status: 400, message: '등록되지 않은 상품 유형입니다.' },
  PRODUCT_TYPE_DUPLICATED: { status: 409, message: '이미 등록된 상품 유형입니다.' },
  ORDER_NOT_FOUND: { status: 404, message: '주문을 찾을 수 없습니다.' },
  ORDER_AMOUNT_INVALID: { status: 400, message: '주문 항목 합계와 주문 금액이 일치하지 않습니다.' },
  ORDER_EXPIRED: { status: 409, message: '결제 가능 시간이 지난 주문입니다.' },
  ORDER_ALREADY_PAID: { status: 409, message: '이미 결제된 주문입니다.' },
  ORDER_IDEMPOTENCY_CONFLICT: { status: 409, message: '같은 주문번호로 다른 내용의 주문이 이미 존재합니다.' },

  // 결제·취소
  PAYMENT_NOT_FOUND: { status: 404, message: '결제 내역을 찾을 수 없습니다.' },
  PAYMENT_AMOUNT_MISMATCH: { status: 400, message: '결제 금액이 주문 금액과 일치하지 않습니다.' },
  PAYMENT_IDEMPOTENCY_CONFLICT: { status: 409, message: '같은 멱등키로 다른 내용의 결제 요청이 이미 존재합니다.' },
  PAYMENT_IN_PROGRESS: { status: 409, message: '결제가 처리 중입니다. 잠시 후 결과를 확인해주세요.' },
  PAYMENT_NOT_CANCELABLE: { status: 409, message: '취소할 수 없는 결제 상태입니다.' },
  CANCEL_AMOUNT_EXCEEDED: { status: 400, message: '환불 가능 금액을 초과했습니다.' },
  CANCEL_IDEMPOTENCY_CONFLICT: { status: 409, message: '같은 멱등키로 다른 내용의 환불 요청이 이미 존재합니다.' },
  CANCEL_IN_PROGRESS: { status: 409, message: '환불이 처리 중입니다. 잠시 후 결과를 확인해주세요.' },
  /** 토스가 취소를 거절 (취소 불가 금액 등). detail.pgCode·pgMessage로 사유 전달 */
  CANCEL_REJECTED: { status: 409, message: '결제 대행사가 환불을 처리하지 않았습니다.' },
  /** 토스가 승인을 거절 (카드 한도 초과 등). detail.pgCode·pgMessage로 사유 전달 */
  PAYMENT_REJECTED: { status: 402, message: '결제 대행사가 결제를 승인하지 않았습니다.' },
  /** 토스가 카드 등록(빌링키 발급)을 거절. detail.pgCode·pgMessage로 사유 전달 */
  BILLING_KEY_REJECTED: { status: 402, message: '결제 대행사가 카드 등록을 승인하지 않았습니다.' },
  BILLING_KEY_NOT_FOUND: { status: 404, message: '등록된 자동결제 수단을 찾을 수 없습니다.' },

  // PG
  PG_CREDENTIAL_NOT_FOUND: { status: 500, message: '결제 대행사 설정이 누락되었습니다. 관리자에게 문의해주세요.' },
  PG_TIMEOUT: { status: 504, message: '결제 대행사 응답이 지연되고 있습니다. 결과를 확인 중입니다.' },
  PG_ERROR: { status: 502, message: '결제 대행사에서 오류가 발생했습니다.' },
} as const satisfies Record<string, { status: number; message: string }>;

type ErrorDefinitions = typeof ERROR_DEFINITIONS;
export type ErrorCodeName = keyof ErrorDefinitions;
export type ErrorCodeDefinition<K extends ErrorCodeName = ErrorCodeName> = ErrorDefinitions[K] & { code: K };

/** `ErrorCode.ORDER_NOT_FOUND` → `{ code: 'ORDER_NOT_FOUND', status: 404, message: '...' }` */
export const ErrorCode = Object.fromEntries(
  Object.entries(ERROR_DEFINITIONS).map(([code, definition]) => [code, { code, ...definition }]),
) as { [K in ErrorCodeName]: ErrorCodeDefinition<K> };
