import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_TYPE_KEY, AuthType } from '../decorators/auth.decorator';
import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-code';
import { AdminGuard } from './admin.guard';

/**
 * 전역 가드. 핸들러(없으면 컨트롤러)의 인증 데코레이터에 따라 검증을 위임한다.
 * 데코레이터가 없으면 거부한다 (default deny).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly adminGuard: AdminGuard,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const authType = this.reflector.getAllAndOverride<AuthType | undefined>(AUTH_TYPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    switch (authType) {
      case AuthType.PUBLIC:
        return true;
      case AuthType.ADMIN:
        return this.adminGuard.canActivate(context);
      case AuthType.SERVICE:
        // ApiKeyGuard(서비스 API 키 검증)가 구현되기 전까지 모든 서비스 API 요청을 거부한다
        throw new BusinessException(ErrorCode.UNAUTHORIZED);
      default:
        this.logger.error(
          `인증 데코레이터가 없는 핸들러: ${context.getClass().name}.${context.getHandler().name} — @ServiceApi/@AdminApi/@Public 중 하나를 붙여야 합니다.`,
        );
        throw new BusinessException(ErrorCode.UNAUTHORIZED);
    }
  }
}
