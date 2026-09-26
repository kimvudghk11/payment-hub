import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminApi } from '../../common/decorators/auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { RevenueReportQueryDto, RevenueReportResponseDto } from './admin-report.dto';
import { AdminReportService } from './admin-report.service';

@ApiTags('관리자 API — 리포트')
@ApiBearerAuth('admin-api-key')
@ApiHeader({ name: 'X-Admin-Actor-Id', required: true, description: '작업한 관리자 ID' })
@AdminApi()
@Controller('admin/reports')
export class AdminReportController {
  constructor(private readonly reportService: AdminReportService) {}

  @Get('revenue')
  @ApiOperation({
    summary: '매출·환불 집계',
    description: '원장 기준, KST 날짜 경계. 서비스별 일·월 단위 매출·환불·순매출·건수와 통화별 합계. 기간 최대 366일',
  })
  @ResponseMessage('매출 리포트를 조회했습니다.')
  @ApiResponse({ status: 200, type: RevenueReportResponseDto })
  revenue(@Query() query: RevenueReportQueryDto): Promise<RevenueReportResponseDto> {
    return this.reportService.revenue(query);
  }
}
