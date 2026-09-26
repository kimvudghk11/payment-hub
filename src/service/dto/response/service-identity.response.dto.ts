import { ApiProperty } from '@nestjs/swagger';
import { ServiceStatus } from '../../constants/service.constants';
import { Service } from '../../domain/service.entity';

/** GET /me — 호출한 API 키가 어느 서비스로 인증되는지 */
export class ServiceIdentityResponseDto {
  @ApiProperty({ description: '서비스 ID', example: '0b6f3c1e-2d4a-4b8e-9f10-123456789abc' })
  serviceId: string;

  @ApiProperty({ description: '서비스 코드', example: 'SVC_A' })
  code: string;

  @ApiProperty({ description: '서비스 이름', example: '서비스 A' })
  name: string;

  @ApiProperty({ description: '서비스 상태', enum: Object.values(ServiceStatus), example: ServiceStatus.ACTIVE })
  status: ServiceStatus;

  static from(service: Service): ServiceIdentityResponseDto {
    const dto = new ServiceIdentityResponseDto();
    dto.serviceId = service.serviceId;
    dto.code = service.code;
    dto.name = service.name;
    dto.status = service.status;
    return dto;
  }
}
