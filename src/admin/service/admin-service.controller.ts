import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminApi } from '../../common/decorators/auth.decorator';
import { CurrentAdminActor } from '../../common/decorators/current-actor.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { IPageable } from '../../common/interceptors/response.interceptor';
import { AdminActor } from '../../common/types/request-context';
import { AdminServiceService } from './admin-service.service';
import { AdminReasonRequestDto } from './dto/request/admin-reason.request.dto';
import { CreateServiceRequestDto } from './dto/request/create-service.request.dto';
import { IssueApiKeyRequestDto } from './dto/request/issue-api-key.request.dto';
import { ListServicesQueryDto } from './dto/request/list-services.query.dto';
import { UpdateServiceRequestDto } from './dto/request/update-service.request.dto';
import {
  AdminServicePageResponseDto,
  AdminServiceResponseDto,
  CreatedServiceResponseDto,
  WebhookSecretResponseDto,
} from './dto/response/admin-service.response.dto';
import { ApiKeyResponseDto, IssuedApiKeyResponseDto } from './dto/response/api-key.response.dto';

const ServiceIdParam = () => Param('serviceId', ParseUUIDPipe);

@ApiTags('관리자 API — 서비스')
@ApiBearerAuth('admin-api-key')
@ApiHeader({ name: 'X-Admin-Actor-Id', required: true, description: '작업한 관리자 ID' })
@AdminApi()
@Controller('admin/services')
export class AdminServiceController {
  constructor(private readonly adminServiceService: AdminServiceService) {}

  @Post()
  @ApiOperation({ summary: '서비스 등록', description: '웹훅 서명 키를 함께 발급하며 평문은 이 응답에서 1회만 반환' })
  @ResponseMessage('서비스가 등록되었습니다.')
  @ApiResponse({ status: 201, type: CreatedServiceResponseDto })
  async create(
    @Body() dto: CreateServiceRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<CreatedServiceResponseDto> {
    const { service, webhookSecret } = await this.adminServiceService.create(dto, actor);
    return CreatedServiceResponseDto.withSecret(service, webhookSecret);
  }

  @Get()
  @ApiOperation({
    summary: '서비스 목록',
    description: '최신순 cursor 페이징. 삭제된 서비스는 includeDeleted=true일 때만',
  })
  @ResponseMessage('서비스 목록을 조회했습니다.')
  @ApiResponse({ status: 200, type: AdminServicePageResponseDto })
  async list(@Query() query: ListServicesQueryDto): Promise<IPageable<AdminServiceResponseDto>> {
    const page = await this.adminServiceService.list(query);
    return { ...page, data: page.data.map((service) => AdminServiceResponseDto.from(service)) };
  }

  @Get(':serviceId')
  @ApiOperation({ summary: '서비스 상세' })
  @ResponseMessage('서비스를 조회했습니다.')
  @ApiResponse({ status: 200, type: AdminServiceResponseDto })
  async get(@ServiceIdParam() serviceId: string): Promise<AdminServiceResponseDto> {
    return AdminServiceResponseDto.from(await this.adminServiceService.get(serviceId));
  }

  @Patch(':serviceId')
  @ApiOperation({ summary: '서비스 수정', description: '이름·웹훅 URL. 바뀐 값이 없으면 감사 로그를 남기지 않음' })
  @ResponseMessage('서비스가 수정되었습니다.')
  @ApiResponse({ status: 200, type: AdminServiceResponseDto })
  async update(
    @ServiceIdParam() serviceId: string,
    @Body() dto: UpdateServiceRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<AdminServiceResponseDto> {
    return AdminServiceResponseDto.from(await this.adminServiceService.update(serviceId, dto.toUpdate(), actor));
  }

  @Post(':serviceId/suspend')
  @HttpCode(200)
  @ApiOperation({ summary: '서비스 정지', description: '사유 필수. 정지되면 키가 유효해도 서비스 API 전부 403' })
  @ResponseMessage('서비스가 정지되었습니다.')
  @ApiResponse({ status: 200, type: AdminServiceResponseDto })
  async suspend(
    @ServiceIdParam() serviceId: string,
    @Body() dto: AdminReasonRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<AdminServiceResponseDto> {
    return AdminServiceResponseDto.from(await this.adminServiceService.suspend(serviceId, dto.reason, actor));
  }

  @Post(':serviceId/resume')
  @HttpCode(200)
  @ApiOperation({ summary: '서비스 재개' })
  @ResponseMessage('서비스가 재개되었습니다.')
  @ApiResponse({ status: 200, type: AdminServiceResponseDto })
  async resume(
    @ServiceIdParam() serviceId: string,
    @Body() dto: AdminReasonRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<AdminServiceResponseDto> {
    return AdminServiceResponseDto.from(await this.adminServiceService.resume(serviceId, dto.reason, actor));
  }

  @Delete(':serviceId')
  @ApiOperation({
    summary: '서비스 삭제',
    description: '사유 필수. soft delete — 결제 이력은 보존, 이후 서비스 API는 401',
  })
  @ResponseMessage('서비스가 삭제되었습니다.')
  @ApiResponse({ status: 200, type: AdminServiceResponseDto })
  async delete(
    @ServiceIdParam() serviceId: string,
    @Body() dto: AdminReasonRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<AdminServiceResponseDto> {
    return AdminServiceResponseDto.from(await this.adminServiceService.delete(serviceId, dto.reason, actor));
  }

  @Post(':serviceId/webhook-secret/rotate')
  @HttpCode(200)
  @ApiOperation({ summary: '웹훅 서명 키 교체', description: '새 키 평문은 이 응답에서 1회만 반환' })
  @ResponseMessage('웹훅 서명 키가 교체되었습니다.')
  @ApiResponse({ status: 200, type: WebhookSecretResponseDto })
  async rotateWebhookSecret(
    @ServiceIdParam() serviceId: string,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<WebhookSecretResponseDto> {
    const webhookSecret = await this.adminServiceService.rotateWebhookSecret(serviceId, actor);
    return { serviceId, webhookSecret };
  }

  @Post(':serviceId/api-keys')
  @ApiOperation({
    summary: 'API 키 발급',
    description: '서비스가 hub를 호출할 때 Authorization: Bearer <apiKey>로 쓰는 키. 평문은 이 응답에서 1회만',
  })
  @ResponseMessage('API 키가 발급되었습니다.')
  @ApiResponse({ status: 201, type: IssuedApiKeyResponseDto })
  async issueApiKey(
    @ServiceIdParam() serviceId: string,
    @Body() dto: IssueApiKeyRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<IssuedApiKeyResponseDto> {
    const { apiKey, plaintext } = await this.adminServiceService.issueApiKey(serviceId, dto, actor);
    return IssuedApiKeyResponseDto.withPlaintext(apiKey, plaintext);
  }

  @Get(':serviceId/api-keys')
  @ApiOperation({ summary: 'API 키 목록', description: 'prefix·hint·만료·마지막 사용 시각만. 평문·해시 미노출' })
  @ResponseMessage('API 키 목록을 조회했습니다.')
  @ApiResponse({ status: 200, type: [ApiKeyResponseDto] })
  async listApiKeys(@ServiceIdParam() serviceId: string): Promise<ApiKeyResponseDto[]> {
    return (await this.adminServiceService.listApiKeys(serviceId)).map((apiKey) => ApiKeyResponseDto.from(apiKey));
  }
}
