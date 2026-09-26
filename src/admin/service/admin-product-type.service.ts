import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { isUniqueViolation } from '../../common/database/unique-violation';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { AdminActor } from '../../common/types/request-context';
import { ProductTypeUpdate, ServiceProductType } from '../../service/domain/service-product-type.entity';
import { Service } from '../../service/domain/service.entity';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminAuditAction, AuditTargetType } from '../audit/constants/admin-audit.constants';
import { lockActiveService } from './service-lock';

/** 상품 유형은 복합 PK라 감사 로그 target_id를 "<serviceId>:<code>"로 남긴다 */
const auditTargetId = (productType: ServiceProductType) => `${productType.serviceId}:${productType.code}`;

/** 서비스별 상품 유형 화이트리스트 관리. 삭제는 없고 isActive로 중지·재개한다 */
@Injectable()
export class AdminProductTypeService {
  constructor(
    @InjectRepository(Service) private readonly services: Repository<Service>,
    @InjectRepository(ServiceProductType) private readonly productTypes: Repository<ServiceProductType>,
    private readonly audit: AdminAuditService,
  ) {}

  @Transactional()
  async create(serviceId: string, params: { code: string; name: string }, actor: AdminActor) {
    await lockActiveService(this.services, serviceId);
    if (await this.productTypes.existsBy({ serviceId, code: params.code })) {
      throw new BusinessException(ErrorCode.PRODUCT_TYPE_DUPLICATED);
    }

    const productType = ServiceProductType.create({ serviceId, ...params });
    try {
      await this.productTypes.insert(productType);
    } catch (error) {
      if (isUniqueViolation(error, 'pk_tb_service_product_type')) {
        throw new BusinessException(ErrorCode.PRODUCT_TYPE_DUPLICATED);
      }
      throw error;
    }

    await this.audit.record({
      actor,
      action: AdminAuditAction.PRODUCT_TYPE_CREATED,
      targetType: AuditTargetType.PRODUCT_TYPE,
      targetId: auditTargetId(productType),
      serviceId,
      after: productType.auditSnapshot(),
    });
    return this.productTypes.findOneByOrFail({ serviceId, code: params.code });
  }

  async list(serviceId: string, isActive?: boolean): Promise<ServiceProductType[]> {
    if (!(await this.services.existsBy({ serviceId, deletedAt: IsNull() }))) {
      throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
    }
    return this.productTypes.find({
      where: { serviceId, ...(isActive === undefined ? {} : { isActive }) },
      order: { code: 'ASC' },
    });
  }

  @Transactional()
  async update(serviceId: string, code: string, changes: ProductTypeUpdate, actor: AdminActor) {
    await lockActiveService(this.services, serviceId);
    const productType = await this.productTypes.findOne({
      where: { serviceId, code },
      lock: { mode: 'pessimistic_write' },
    });
    if (!productType) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);

    const before = productType.auditSnapshot();
    if (productType.update(changes).length === 0) return productType;

    await this.productTypes.save(productType);
    await this.audit.record({
      actor,
      action: AdminAuditAction.PRODUCT_TYPE_UPDATED,
      targetType: AuditTargetType.PRODUCT_TYPE,
      targetId: auditTargetId(productType),
      serviceId,
      before,
      after: productType.auditSnapshot(),
    });
    return productType;
  }
}
