import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-code';
import '../types/request-context';
import { extractBearerToken } from './bearer-token';

// tb_admin_audit_log의 actor_id·actor_name·request_id 컬럼 길이
const MAX_HEADER_LENGTH = 100;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * admin 레포 전용 키 + 관리자 식별 헤더 검증 (CLAUDE.md 6.1).
 * 키는 env ADMIN_API_KEY_HASHES(SHA-256 hex, 쉼표 구분)와 비교한다. 여러 개 → 무중단 교체.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly keyHashes: Buffer[];

  constructor(config: ConfigService) {
    const hashes = (config.get<string>('ADMIN_API_KEY_HASHES') ?? '')
      .split(',')
      .map((hash) => hash.trim())
      .filter(Boolean);

    // 잘못된 값이 섞이면 조용히 무시하지 않고 부팅을 막는다 (값 자체는 로그에 남기지 않음)
    const invalidCount = hashes.filter((hash) => !SHA256_HEX.test(hash)).length;
    if (invalidCount > 0) {
      throw new Error(`ADMIN_API_KEY_HASHES에 SHA-256 hex가 아닌 값이 ${invalidCount}개 있습니다.`);
    }
    this.keyHashes = hashes.map((hash) => Buffer.from(hash, 'hex'));
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    const token = extractBearerToken(req);
    if (!token || !this.isRegisteredKey(token)) {
      throw new BusinessException(ErrorCode.UNAUTHORIZED);
    }

    const actorId = req.header('x-admin-actor-id')?.trim();
    if (!actorId) {
      throw new BusinessException(ErrorCode.ADMIN_ACTOR_REQUIRED);
    }

    const actorName = decodeHeader(req.header('x-admin-actor-name'));
    const requestId = req.header('x-request-id') ?? null;
    assertMaxLength({ 'X-Admin-Actor-Id': actorId, 'X-Admin-Actor-Name': actorName, 'X-Request-Id': requestId });

    req.adminActor = { actorId, actorName, requestId, ip: req.ip ?? null };
    return true;
  }

  private isRegisteredKey(token: string): boolean {
    const hash = createHash('sha256').update(token).digest();
    return this.keyHashes.some((registered) => timingSafeEqual(registered, hash));
  }
}

const decodeHeader = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const assertMaxLength = (headers: Record<string, string | null>): void => {
  const errors = Object.entries(headers)
    .filter(([, value]) => value !== null && value.length > MAX_HEADER_LENGTH)
    .map(([field]) => ({ field, message: `${field}는 ${MAX_HEADER_LENGTH}자 이하여야 합니다.` }));
  if (errors.length > 0) {
    throw new BusinessException(ErrorCode.INVALID_REQUEST, { errors });
  }
};
