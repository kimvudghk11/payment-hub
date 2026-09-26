import { IsNull, Repository } from 'typeorm';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { Service } from '../../service/domain/service.entity';

/**
 * 삭제되지 않은 서비스를 쓰기 락으로 조회한다. 서비스 하위 자원(키·PG·상품 유형) 관리 작업을 서비스 단위로 직렬화.
 * 삭제된 서비스는 관리 대상에서 사라진 것으로 보고 404.
 */
export const lockActiveService = async (services: Repository<Service>, serviceId: string): Promise<Service> => {
  const service = await services.findOne({
    where: { serviceId, deletedAt: IsNull() },
    lock: { mode: 'pessimistic_write' },
  });
  if (!service) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
  return service;
};
