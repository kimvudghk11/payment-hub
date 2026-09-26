import { ErrorCodeDefinition } from './error-code';

/**
 * hub의 모든 예상된 실패. 전역 필터가 `{ success, code, message, detail }`로 변환한다.
 * detail에는 비밀값·개인정보를 넣지 않는다.
 */
export class BusinessException extends Error {
  constructor(
    readonly errorCode: ErrorCodeDefinition,
    readonly detail?: Record<string, unknown>,
  ) {
    super(errorCode.message);
    this.name = 'BusinessException';
  }
}
