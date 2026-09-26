import { ErrorCode, ErrorCodeDefinition } from '../common/errors/error-code';

/** hub 설정(토스 키) 문제로 난 실패 — 사용자 카드 문제가 아니므로 PAYMENT_REJECTED가 아니라 PG_ERROR */
const HUB_CONFIG_ERROR_CODES = new Set(['UNAUTHORIZED_KEY', 'INVALID_API_KEY']);

/** 토스가 거절한 코드 → hub 에러 코드. 토스 원본 코드·메시지는 detail.pgCode·pgMessage로 따로 전달한다 */
export const hubErrorForTossRejection = (pgCode: string): ErrorCodeDefinition =>
  HUB_CONFIG_ERROR_CODES.has(pgCode) ? ErrorCode.PG_ERROR : ErrorCode.PAYMENT_REJECTED;
