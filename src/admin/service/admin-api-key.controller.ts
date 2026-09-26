import { Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminApi } from '../../common/decorators/auth.decorator';
import { CurrentAdminActor } from '../../common/decorators/current-actor.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AdminActor } from '../../common/types/request-context';
import { AdminServiceService } from './admin-service.service';
import { ApiKeyResponseDto } from './dto/response/api-key.response.dto';

@ApiTags('관리자 API — 서비스')
@ApiBearerAuth('admin-api-key')
@ApiHeader({ name: 'X-Admin-Actor-Id', required: true, description: '작업한 관리자 ID' })
@AdminApi()
@Controller('admin/api-keys')
export class AdminApiKeyController {
  constructor(private readonly adminServiceService: AdminServiceService) {}

  @Post(':apiKeyId/revoke')
  @HttpCode(200)
  @ApiOperation({
    summary: 'API 키 폐기',
    description:
      '이미 폐기된 키면 그대로 200 (멱등). 교체 절차: 새 키 발급 → 서비스 배포 → 구 키 lastUsedAt 확인 → 폐기',
  })
  @ResponseMessage('API 키가 폐기되었습니다.')
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async revoke(
    @Param('apiKeyId', ParseUUIDPipe) apiKeyId: string,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<ApiKeyResponseDto> {
    return ApiKeyResponseDto.from(await this.adminServiceService.revokeApiKey(apiKeyId, actor));
  }
}
