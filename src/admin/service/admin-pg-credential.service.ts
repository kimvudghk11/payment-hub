import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { AdminActor } from '../../common/types/request-context';
import { PgProvider } from '../../pg/constants/pg.constants';
import { PgCredential } from '../../service/domain/pg-credential.entity';
import { Service } from '../../service/domain/service.entity';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminAuditAction, AuditTargetType } from '../audit/constants/admin-audit.constants';
import { RegisterPgCredentialRequestDto } from './dto/request/register-pg-credential.request.dto';
import { lockActiveService } from './service-lock';

/** 서비스별 토스 자격증명 관리. 시크릿 키는 등록 시 암호화하고 이후 어디에도 평문으로 나가지 않는다 */
@Injectable()
export class AdminPgCredentialService {
  constructor(
    @InjectRepository(Service) private readonly services: Repository<Service>,
    @InjectRepository(PgCredential) private readonly credentials: Repository<PgCredential>,
    private readonly encryption: EncryptionService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * 새 키 등록. 같은 (서비스, 환경)의 기존 활성 키는 같은 트랜잭션에서 비활성하고,
   * 교체 사실은 등록 감사 로그의 before에 남긴다 (자동 비활성이라 사유를 따로 받지 않음).
   */
  @Transactional()
  async register(serviceId: string, dto: RegisterPgCredentialRequestDto, actor: AdminActor): Promise<PgCredential> {
    await lockActiveService(this.services, serviceId);

    const credential = PgCredential.register({
      serviceId,
      environment: dto.environment,
      merchantId: dto.merchantId ?? null,
      clientKey: dto.clientKey,
      secretKey: dto.secretKey,
      encrypt: (plaintext) => this.encryption.encrypt(plaintext),
    });

    // 부분 유니크 인덱스(활성 1개) 때문에 기존 키를 먼저 끈다
    const previous = await this.credentials.findOneBy({
      serviceId,
      provider: PgProvider.TOSS,
      environment: dto.environment,
      isActive: true,
    });
    if (previous?.deactivate()) await this.credentials.save(previous);
    await this.credentials.save(credential);

    await this.audit.record({
      actor,
      action: AdminAuditAction.PG_CREDENTIAL_REGISTERED,
      targetType: AuditTargetType.PG_CREDENTIAL,
      targetId: credential.pgCredentialId,
      serviceId,
      before: previous ? { replacedPgCredentialId: previous.pgCredentialId, ...previous.auditSnapshot() } : null,
      after: credential.auditSnapshot(),
    });
    return credential;
  }

  async list(serviceId: string): Promise<PgCredential[]> {
    await this.assertServiceExists(serviceId);
    return this.credentials.find({ where: { serviceId }, order: { createdAt: 'DESC' } });
  }

  @Transactional()
  async deactivate(pgCredentialId: string, reason: string | undefined, actor: AdminActor): Promise<PgCredential> {
    const credential = await this.credentials.findOne({
      where: { pgCredentialId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!credential) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);

    const before = credential.auditSnapshot();
    if (!credential.deactivate()) return credential;

    await this.credentials.save(credential);
    await this.audit.record({
      actor,
      action: AdminAuditAction.PG_CREDENTIAL_DEACTIVATED,
      targetType: AuditTargetType.PG_CREDENTIAL,
      targetId: pgCredentialId,
      serviceId: credential.serviceId,
      before,
      after: credential.auditSnapshot(),
      reason,
    });
    return credential;
  }

  private async assertServiceExists(serviceId: string): Promise<void> {
    const exists = await this.services.existsBy({ serviceId, deletedAt: IsNull() });
    if (!exists) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
  }
}
