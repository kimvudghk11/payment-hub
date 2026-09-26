import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminApi } from '../../common/decorators/auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { IPageable } from '../../common/interceptors/response.interceptor';
import { AdminAuditService } from './admin-audit.service';
import { AuditLogPageResponseDto, AuditLogResponseDto, ListAuditLogsQueryDto } from './dto/admin-audit-log.dto';

@ApiTags('관리자 API — 감사 로그')
@ApiBearerAuth('admin-api-key')
@ApiHeader({ name: 'X-Admin-Actor-Id', required: true, description: '작업한 관리자 ID' })
@AdminApi()
@Controller('admin/audit-logs')
export class AdminAuditController {
  constructor(private readonly auditService: AdminAuditService) {}

  @Get()
  @ApiOperation({
    summary: '감사 로그 조회',
    description: '작업자·작업 종류·대상·서비스·기간 필터, 최신순 cursor 페이징. before/after에는 비밀값이 없다',
  })
  @ResponseMessage('감사 로그를 조회했습니다.')
  @ApiResponse({ status: 200, type: AuditLogPageResponseDto })
  async list(@Query() query: ListAuditLogsQueryDto): Promise<IPageable<AuditLogResponseDto>> {
    const page = await this.auditService.list(query);
    return { ...page, data: page.data.map((log) => AuditLogResponseDto.from(log)) };
  }
}
