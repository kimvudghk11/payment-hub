import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { DataSource } from 'typeorm';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-code';
import { extractBearerToken } from '../common/guards/bearer-token';
import '../common/types/request-context';
import { ServiceApiKey } from './domain/service-api-key.entity';
import { Service } from './domain/service.entity';

/**
 * 서비스 API 키 검증 (CLAUDE.md 8장 인증).
 * SHA-256 해시로 키 조회 → 폐기·만료·서비스 삭제·정지 순으로 거부 → req.serviceId 설정.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(req);
    if (!token) throw new BusinessException(ErrorCode.UNAUTHORIZED);

    const apiKey = await this.dataSource.getRepository(ServiceApiKey).findOneBy({ keyHash: ServiceApiKey.hash(token) });
    if (!apiKey) throw new BusinessException(ErrorCode.UNAUTHORIZED);

    const now = new Date();
    if (apiKey.isRevoked) throw new BusinessException(ErrorCode.API_KEY_REVOKED);
    if (apiKey.isExpired(now)) throw new BusinessException(ErrorCode.API_KEY_EXPIRED);

    const service = await this.dataSource.getRepository(Service).findOneBy({ serviceId: apiKey.serviceId });
    // 삭제된 서비스는 존재하지 않는 것처럼 다룬다
    if (!service || service.isDeleted) throw new BusinessException(ErrorCode.UNAUTHORIZED);
    if (service.isSuspended) throw new BusinessException(ErrorCode.SERVICE_SUSPENDED);

    req.serviceId = service.serviceId;
    this.touchLastUsed(apiKey, now);
    return true;
  }

  /** 응답을 늦추지 않도록 비동기로 갱신한다. 실패해도 요청은 성공시킨다 */
  private touchLastUsed(apiKey: ServiceApiKey, now: Date): void {
    this.dataSource
      .getRepository(ServiceApiKey)
      .update({ serviceApiKeyId: apiKey.serviceApiKeyId }, { lastUsedAt: now })
      .catch((error: unknown) =>
        this.logger.warn(
          `last_used_at 갱신 실패 (${apiKey.keyPrefix}…${apiKey.keyHint}): ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }
}
