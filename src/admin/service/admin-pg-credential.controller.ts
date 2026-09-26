import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminApi } from '../../common/decorators/auth.decorator';
import { CurrentAdminActor } from '../../common/decorators/current-actor.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AdminActor } from '../../common/types/request-context';
import { AdminPgCredentialService } from './admin-pg-credential.service';
import { AdminReasonRequestDto } from './dto/request/admin-reason.request.dto';
import { RegisterPgCredentialRequestDto } from './dto/request/register-pg-credential.request.dto';
import { PgCredentialResponseDto } from './dto/response/pg-credential.response.dto';

@ApiTags('관리자 API — PG 자격증명')
@ApiBearerAuth('admin-api-key')
@ApiHeader({ name: 'X-Admin-Actor-Id', required: true, description: '작업한 관리자 ID' })
@AdminApi()
@Controller('admin')
export class AdminPgCredentialController {
  constructor(private readonly pgCredentialService: AdminPgCredentialService) {}

  @Post('services/:serviceId/pg-credentials')
  @ApiOperation({
    summary: 'PG 자격증명 등록',
    description: '시크릿 키를 암호화 저장. 같은 환경의 기존 활성 키는 같은 트랜잭션에서 비활성',
  })
  @ResponseMessage('PG 자격증명이 등록되었습니다.')
  @ApiResponse({ status: 201, type: PgCredentialResponseDto })
  async register(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() dto: RegisterPgCredentialRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<PgCredentialResponseDto> {
    return PgCredentialResponseDto.from(await this.pgCredentialService.register(serviceId, dto, actor));
  }

  @Get('services/:serviceId/pg-credentials')
  @ApiOperation({ summary: 'PG 자격증명 목록', description: '최신순. 시크릿 키는 끝 4자리 hint만' })
  @ResponseMessage('PG 자격증명 목록을 조회했습니다.')
  @ApiResponse({ status: 200, type: [PgCredentialResponseDto] })
  async list(@Param('serviceId', ParseUUIDPipe) serviceId: string): Promise<PgCredentialResponseDto[]> {
    return (await this.pgCredentialService.list(serviceId)).map((c) => PgCredentialResponseDto.from(c));
  }

  @Post('pg-credentials/:pgCredentialId/deactivate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'PG 자격증명 비활성',
    description: '사유 필수. 활성 키가 없으면 해당 환경 결제가 PG_CREDENTIAL_NOT_FOUND로 실패',
  })
  @ResponseMessage('PG 자격증명이 비활성되었습니다.')
  @ApiResponse({ status: 200, type: PgCredentialResponseDto })
  async deactivate(
    @Param('pgCredentialId', ParseUUIDPipe) pgCredentialId: string,
    @Body() dto: AdminReasonRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<PgCredentialResponseDto> {
    return PgCredentialResponseDto.from(await this.pgCredentialService.deactivate(pgCredentialId, dto.reason, actor));
  }
}
