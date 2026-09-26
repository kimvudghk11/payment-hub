import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ServiceApi } from '../common/decorators/auth.decorator';
import { CurrentServiceId } from '../common/decorators/current-actor.decorator';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { ServiceIdentityResponseDto } from './dto/response/service-identity.response.dto';
import { ServiceService } from './service.service';

@ApiTags('서비스 API — 연결 확인')
@ApiBearerAuth('service-api-key')
@ServiceApi()
@Controller()
export class ServiceController {
  constructor(private readonly serviceService: ServiceService) {}

  @Get('me')
  @ApiOperation({
    summary: '연결 확인',
    description: 'API 키가 어느 서비스로 인증되는지 확인한다. 키 교체 후 배포 검증에 사용',
  })
  @ResponseMessage('서비스 정보를 조회했습니다.')
  @ApiResponse({ status: 200, type: ServiceIdentityResponseDto })
  async me(@CurrentServiceId() serviceId: string): Promise<ServiceIdentityResponseDto> {
    return ServiceIdentityResponseDto.from(await this.serviceService.getActive(serviceId));
  }
}
