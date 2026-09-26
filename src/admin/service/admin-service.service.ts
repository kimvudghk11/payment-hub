import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Brackets, IsNull, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { pgEnvironmentOf } from '../../common/config/pg-environment.config';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { isUniqueViolation } from '../../common/database/unique-violation';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { IPageable } from '../../common/interceptors/response.interceptor';
import { AdminActor } from '../../common/types/request-context';
import { decodeCursor, encodeCursor } from '../../common/utils/cursor.util';
import { PgEnvironment } from '../../service/constants/service.constants';
import { ServiceApiKey } from '../../service/domain/service-api-key.entity';
import { Service, ServiceUpdate } from '../../service/domain/service.entity';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminAuditAction, AuditTargetType } from '../audit/constants/admin-audit.constants';
import { ListServicesQueryDto } from './dto/request/list-services.query.dto';

const DEFAULT_PAGE_SIZE = 20;
const WEBHOOK_SECRET_PREFIX = 'whsec_';

/**
 * 관리자 서비스·API 키 관리 유스케이스.
 * 모든 쓰기는 대상 행을 잠그고, 감사 로그와 같은 트랜잭션에서 커밋한다 (CLAUDE.md 6.5).
 */
@Injectable()
export class AdminServiceService {
  private readonly environment: PgEnvironment;

  constructor(
    @InjectRepository(Service) private readonly services: Repository<Service>,
    @InjectRepository(ServiceApiKey) private readonly apiKeys: Repository<ServiceApiKey>,
    private readonly encryption: EncryptionService,
    private readonly audit: AdminAuditService,
    config: ConfigService,
  ) {
    this.environment = pgEnvironmentOf(config);
  }

  // ---------- 서비스 ----------

  @Transactional()
  async create(
    params: { code: string; name: string; webhookUrl?: string },
    actor: AdminActor,
  ): Promise<{ service: Service; webhookSecret: string }> {
    if (await this.services.existsBy({ code: params.code })) {
      throw new BusinessException(ErrorCode.SERVICE_CODE_DUPLICATED);
    }

    const service = Service.create(params);
    const webhookSecret = generateWebhookSecret();
    service.rotateWebhookSecret(this.encryption.encrypt(webhookSecret));
    try {
      await this.services.save(service);
    } catch (error) {
      // 사전 조회와 저장 사이에 같은 코드가 등록된 경우
      if (isUniqueViolation(error, 'uq_tb_service_code')) {
        throw new BusinessException(ErrorCode.SERVICE_CODE_DUPLICATED);
      }
      throw error;
    }

    await this.audit.record({
      actor,
      action: AdminAuditAction.SERVICE_CREATED,
      targetType: AuditTargetType.SERVICE,
      targetId: service.serviceId,
      serviceId: service.serviceId,
      after: service.auditSnapshot(),
    });
    return { service, webhookSecret };
  }

  async list(query: ListServicesQueryDto): Promise<IPageable<Service>> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const filtered = this.services.createQueryBuilder('s');
    if (!query.includeDeleted) filtered.andWhere('s.deletedAt IS NULL');
    if (query.status) filtered.andWhere('s.status = :status', { status: query.status });

    const totalCount = await filtered.clone().getCount();

    const page = filtered.clone();
    if (query.cursor) {
      const { createdAt, id } = decodeCursor(query.cursor);
      page.andWhere(
        new Brackets((qb) =>
          qb
            .where('s.createdAt < :createdAt', { createdAt })
            .orWhere('s.createdAt = :createdAt AND s.serviceId < :id', {
              createdAt,
              id,
            }),
        ),
      );
    }
    const rows = await page
      .orderBy('s.createdAt', 'DESC')
      .addOrderBy('s.serviceId', 'DESC')
      .take(limit + 1)
      .getMany();

    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    return {
      data,
      totalCount,
      nextCursor: rows.length > limit ? encodeCursor({ createdAt: last.createdAt, id: last.serviceId }) : null,
    };
  }

  async get(serviceId: string): Promise<Service> {
    const service = await this.services.findOneBy({ serviceId, deletedAt: IsNull() });
    if (!service) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
    return service;
  }

  @Transactional()
  async update(serviceId: string, changes: ServiceUpdate, actor: AdminActor): Promise<Service> {
    const service = await this.lockService(serviceId);
    const before = service.auditSnapshot();

    const changed = service.update(changes);
    if (changed.length === 0) return service;

    await this.services.save(service);
    await this.audit.record({
      actor,
      // 웹훅 URL만 바뀐 경우는 따로 추적한다 (이벤트 수신처 변경)
      action:
        changed.length === 1 && changed[0] === 'webhookUrl'
          ? AdminAuditAction.WEBHOOK_CONFIG_UPDATED
          : AdminAuditAction.SERVICE_UPDATED,
      targetType: AuditTargetType.SERVICE,
      targetId: serviceId,
      serviceId,
      before,
      after: service.auditSnapshot(),
    });
    return service;
  }

  @Transactional()
  async suspend(serviceId: string, reason: string | undefined, actor: AdminActor): Promise<Service> {
    return this.changeState(serviceId, actor, AdminAuditAction.SERVICE_SUSPENDED, reason, (s) => s.suspend());
  }

  @Transactional()
  async resume(serviceId: string, reason: string | undefined, actor: AdminActor): Promise<Service> {
    return this.changeState(serviceId, actor, AdminAuditAction.SERVICE_RESUMED, reason, (s) => s.resume());
  }

  @Transactional()
  async delete(serviceId: string, reason: string | undefined, actor: AdminActor): Promise<Service> {
    return this.changeState(serviceId, actor, AdminAuditAction.SERVICE_DELETED, reason, (s) => {
      s.delete(new Date());
      return true;
    });
  }

  @Transactional()
  async rotateWebhookSecret(serviceId: string, actor: AdminActor): Promise<string> {
    const service = await this.lockService(serviceId);
    const webhookSecret = generateWebhookSecret();
    service.rotateWebhookSecret(this.encryption.encrypt(webhookSecret));
    await this.services.save(service);

    await this.audit.record({
      actor,
      action: AdminAuditAction.WEBHOOK_SECRET_ROTATED,
      targetType: AuditTargetType.SERVICE,
      targetId: serviceId,
      serviceId,
    });
    return webhookSecret;
  }

  // ---------- API 키 ----------

  @Transactional()
  async issueApiKey(
    serviceId: string,
    params: { label: string; expiresAt?: string },
    actor: AdminActor,
  ): Promise<{ apiKey: ServiceApiKey; plaintext: string }> {
    await this.lockService(serviceId);

    const { apiKey, plaintext } = ServiceApiKey.issue({
      serviceId,
      label: params.label,
      expiresAt: params.expiresAt ? new Date(params.expiresAt) : null,
      environment: this.environment,
      now: new Date(),
    });
    await this.apiKeys.save(apiKey);

    await this.audit.record({
      actor,
      action: AdminAuditAction.API_KEY_ISSUED,
      targetType: AuditTargetType.API_KEY,
      targetId: apiKey.serviceApiKeyId,
      serviceId,
      after: apiKey.auditSnapshot(),
    });
    return { apiKey, plaintext };
  }

  async listApiKeys(serviceId: string): Promise<ServiceApiKey[]> {
    await this.get(serviceId);
    return this.apiKeys.find({ where: { serviceId }, order: { createdAt: 'DESC' } });
  }

  @Transactional()
  async revokeApiKey(apiKeyId: string, actor: AdminActor): Promise<ServiceApiKey> {
    const apiKey = await this.apiKeys.findOne({
      where: { serviceApiKeyId: apiKeyId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!apiKey) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);

    const before = apiKey.auditSnapshot();
    if (!apiKey.revoke(new Date())) return apiKey;

    await this.apiKeys.save(apiKey);
    await this.audit.record({
      actor,
      action: AdminAuditAction.API_KEY_REVOKED,
      targetType: AuditTargetType.API_KEY,
      targetId: apiKeyId,
      serviceId: apiKey.serviceId,
      before,
      after: apiKey.auditSnapshot(),
    });
    return apiKey;
  }

  // ---------- 내부 ----------

  /** 상태 전이 + 감사 로그. 엔티티가 "바뀌지 않았다"(멱등)고 하면 감사 로그 없이 현재 상태를 돌려준다 */
  private async changeState(
    serviceId: string,
    actor: AdminActor,
    action: AdminAuditAction,
    reason: string | undefined,
    transition: (service: Service) => boolean,
  ): Promise<Service> {
    const service = await this.lockService(serviceId);
    const before = service.auditSnapshot();
    if (!transition(service)) return service;

    await this.services.save(service);
    // 사유 검증은 감사 로그 도메인이 한다. 실패하면 트랜잭션 전체가 롤백된다
    await this.audit.record({
      actor,
      action,
      targetType: AuditTargetType.SERVICE,
      targetId: serviceId,
      serviceId,
      before,
      after: service.auditSnapshot(),
      reason,
    });
    return service;
  }

  /** 삭제되지 않은 서비스를 쓰기 락으로 조회. 동시 관리 작업을 직렬화한다 */
  private async lockService(serviceId: string): Promise<Service> {
    const service = await this.services.findOne({
      where: { serviceId, deletedAt: IsNull() },
      lock: { mode: 'pessimistic_write' },
    });
    if (!service) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
    return service;
  }
}

const generateWebhookSecret = (): string => `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
