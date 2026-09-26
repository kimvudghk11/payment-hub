import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { BusinessException } from '../errors/business.exception';
import { ErrorCode, ErrorCodeDefinition } from '../errors/error-code';

// 프레임워크가 던지는 Nest 내장 예외(라우트 없음, JSON 파싱 실패 등) → hub 코드
const NEST_STATUS_TO_ERROR: Partial<Record<number, ErrorCodeDefinition>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.INVALID_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.NOT_FOUND]: ErrorCode.RESOURCE_NOT_FOUND,
};

/**
 * 모든 예외를 `{ success: false, code, message, detail? }`로 변환한다.
 * 예상 못 한 예외는 500 INTERNAL_ERROR로 응답하고, 스택·SQL 등 내부 정보는 로그로만 남긴다.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { errorCode, detail } = this.resolve(exception);

    if (errorCode.status >= 500) {
      this.logger.error(
        `${errorCode.code}: ${exception instanceof Error ? exception.message : String(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(errorCode.status).json({
      success: false,
      code: errorCode.code,
      message: errorCode.message,
      ...(detail && { detail }),
    });
  }

  private resolve(exception: unknown): { errorCode: ErrorCodeDefinition; detail?: Record<string, unknown> } {
    if (exception instanceof BusinessException) {
      return { errorCode: exception.errorCode, detail: exception.detail };
    }
    if (exception instanceof HttpException) {
      const errorCode = NEST_STATUS_TO_ERROR[exception.getStatus()];
      if (errorCode) return { errorCode };
    }
    return { errorCode: ErrorCode.INTERNAL_ERROR };
  }
}
