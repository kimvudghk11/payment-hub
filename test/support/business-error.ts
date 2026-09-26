import { BusinessException } from '../../src/common/errors/business.exception';
import { ErrorCodeName } from '../../src/common/errors/error-code';

/** fn이 BusinessException을 던지고, 그 에러 code가 기대값인지 검증한다 */
export const expectBusinessError = (fn: () => unknown, code: ErrorCodeName): void => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BusinessException);
  expect((thrown as BusinessException).errorCode.code).toBe(code);
};
