import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { ValidationMessage } from '../../common/utils/validation-message.util';

export const REPORT_GROUP_BY = ['day', 'month'] as const;
export type ReportGroupBy = (typeof REPORT_GROUP_BY)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class RevenueReportQueryDto {
  @ApiProperty({ description: '시작일 (KST, 포함)', example: '2026-10-01' })
  @Matches(DATE, { message: ValidationMessage.format('from', 'YYYY-MM-DD') })
  from: string;

  @ApiProperty({ description: '종료일 (KST, 포함). 기간은 최대 366일', example: '2026-10-31' })
  @Matches(DATE, { message: ValidationMessage.format('to', 'YYYY-MM-DD') })
  to: string;

  @ApiPropertyOptional({ description: '집계 단위', enum: REPORT_GROUP_BY, default: 'day' })
  @IsOptional()
  @IsIn(REPORT_GROUP_BY, { message: ValidationMessage.oneOf('groupBy', REPORT_GROUP_BY) })
  groupBy?: ReportGroupBy;

  @ApiPropertyOptional({ description: '서비스 ID. 없으면 서비스별로 나눠 준다' })
  @IsOptional()
  @IsUUID('all', { message: ValidationMessage.uuid('serviceId') })
  serviceId?: string;
}

export class RevenueRowDto {
  @ApiProperty() serviceId: string;
  @ApiProperty({ description: 'KST 기준 일(YYYY-MM-DD) 또는 월(YYYY-MM)', example: '2026-10-01' }) period: string;
  @ApiProperty({ example: 'KRW' }) currency: string;
  @ApiProperty({ description: '매출 (결제 승인, 원장 REVENUE 대변)', example: 50000 }) revenue: number;
  @ApiProperty({ description: '환불 (원장 REFUND 차변)', example: 10000 }) refund: number;
  @ApiProperty({ description: '순매출 = 매출 − 환불', example: 40000 }) net: number;
  @ApiProperty({ description: '결제 승인 건수' }) paymentCount: number;
  @ApiProperty({ description: '환불 건수' }) cancelCount: number;
}

export class RevenueTotalDto {
  @ApiProperty({ example: 'KRW' }) currency: string;
  @ApiProperty() revenue: number;
  @ApiProperty() refund: number;
  @ApiProperty() net: number;
}

export class RevenueReportResponseDto {
  @ApiProperty({ type: [RevenueRowDto], description: '기간 → 서비스 순' }) rows: RevenueRowDto[];
  @ApiProperty({ type: [RevenueTotalDto], description: '통화별 합계' }) totals: RevenueTotalDto[];
}
