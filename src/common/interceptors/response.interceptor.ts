import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { RESPONSE_MESSAGE_KEY } from '../decorators/response-message.decorator';

export interface IResponseBase<T> {
  success: true;
  message: string;
  data: T;
}

/** 목록 응답의 data. cursor 기반 페이징 (created_at DESC, id DESC) */
export interface IPageable<T> {
  data: T[];
  totalCount: number;
  nextCursor: string | null;
}

const DEFAULT_MESSAGE = '요청을 처리했습니다.';

/** 핸들러 반환값을 `{ success: true, message, data }`로 감싼다. 에러는 HttpExceptionFilter가 처리 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, IResponseBase<T>> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<IResponseBase<T>> {
    const message =
      this.reflector.getAllAndOverride<string | undefined>(RESPONSE_MESSAGE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_MESSAGE;
    return next.handle().pipe(map((data) => ({ success: true as const, message, data })));
  }
}
