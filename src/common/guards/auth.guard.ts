import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from '../../service/api-key.guard';
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
    private readonly apiKeyGuard: ApiKeyGuard,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
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
        return this.apiKeyGuard.canActivate(context);
      default:
        this.logger.error(
          `인증 데코레이터가 없는 핸들러: ${context.getClass().name}.${context.getHandler().name} — @ServiceApi/@AdminApi/@Public 중 하나를 붙여야 합니다.`,
        );
        throw new BusinessException(ErrorCode.UNAUTHORIZED);
    }
  }
}
