import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { pgEnvironmentOf } from '../common/config/pg-environment.config';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-code';
import { PgProvider } from '../pg/constants/pg.constants';
import { PgEnvironment } from './constants/service.constants';
import { PgCredential } from './domain/pg-credential.entity';
import { Service } from './domain/service.entity';

/** 서비스 API 쪽 조회. 항상 인증된 서비스 자기 자신의 데이터만 본다 */
@Injectable()
export class ServiceService {
  private readonly environment: PgEnvironment;

  constructor(
    @InjectRepository(Service) private readonly services: Repository<Service>,
    @InjectRepository(PgCredential) private readonly credentials: Repository<PgCredential>,
    config: ConfigService,
  ) {
    this.environment = pgEnvironmentOf(config);
  }

  async getActive(serviceId: string): Promise<Service> {
    const service = await this.services.findOneBy({ serviceId, deletedAt: IsNull() });
    if (!service) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
    return service;
  }

  /** 이 배포 환경의 활성 토스 자격증명. 없으면 결제를 진행할 수 없으므로 PG_CREDENTIAL_NOT_FOUND */
  async getActivePgCredential(serviceId: string): Promise<PgCredential & { clientKey: string }> {
    const credential = await this.credentials.findOneBy({
      serviceId,
      provider: PgProvider.TOSS,
      environment: this.environment,
      isActive: true,
    });
    if (!credential?.clientKey) throw new BusinessException(ErrorCode.PG_CREDENTIAL_NOT_FOUND);
    return credential as PgCredential & { clientKey: string };
  }
}
