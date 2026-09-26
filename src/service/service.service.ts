import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-code';
import { Service } from './domain/service.entity';

/** 서비스 API 쪽 서비스 조회 (자기 서비스만) */
@Injectable()
export class ServiceService {
  constructor(@InjectRepository(Service) private readonly services: Repository<Service>) {}

  async getActive(serviceId: string): Promise<Service> {
    const service = await this.services.findOneBy({ serviceId, deletedAt: IsNull() });
    if (!service) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
    return service;
  }
}
