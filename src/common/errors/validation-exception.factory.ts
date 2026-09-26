import { ValidationError } from 'class-validator';
import { BusinessException } from './business.exception';
import { ErrorCode } from './error-code';

export interface FieldError {
  /** 중첩 필드는 점 경로 (예: `items.0.quantity`) */
  field: string;
  message: string;
}

// forbidNonWhitelisted가 만드는 영문 메시지 대체
const WHITELIST_CONSTRAINT = 'whitelistValidation';
const WHITELIST_MESSAGE = '허용되지 않은 필드입니다.';

const flatten = (errors: ValidationError[], parentPath = ''): FieldError[] =>
  errors.flatMap((error) => {
    const field = parentPath ? `${parentPath}.${error.property}` : error.property;
    const own = Object.entries(error.constraints ?? {}).map(([constraint, message]) => ({
      field,
      message: constraint === WHITELIST_CONSTRAINT ? WHITELIST_MESSAGE : message,
    }));
    return [...own, ...flatten(error.children ?? [], field)];
  });

/** ValidationPipe 실패 → 400 INVALID_REQUEST, 필드별 메시지는 detail.errors */
export const validationExceptionFactory = (errors: ValidationError[]): BusinessException =>
  new BusinessException(ErrorCode.INVALID_REQUEST, { errors: flatten(errors) });
