import { Module } from '@nestjs/common';
import { AdminReportController } from './admin-report.controller';
import { AdminReportService } from './admin-report.service';

/** 원장 기반 매출·환불 집계 (CLAUDE.md 7장 admin/report) */
@Module({
  controllers: [AdminReportController],
  providers: [AdminReportService],
})
export class AdminReportModule {}
