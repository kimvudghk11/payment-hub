import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ValidationMessage } from '../../../common/utils/validation-message.util';
import { AdminAuditAction } from '../constants/admin-audit.constants';
import { AdminAuditLog } from '../domain/admin-audit-log.entity';

const ACTIONS = Object.values(AdminAuditAction);

export class ListAuditLogsQueryDto {
  @ApiPropertyOptional({ description: '작업한 관리자 ID', example: 'admin-7' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('actorId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('actorId', 100) })
  actorId?: string;

  @ApiPropertyOptional({ description: '작업 종류', enum: ACTIONS })
  @IsOptional()
  @IsIn(ACTIONS, { message: ValidationMessage.oneOf('action', ACTIONS) })
  action?: AdminAuditAction;

  @ApiPropertyOptional({ description: '대상 종류 (SERVICE, API_KEY, PAYMENT, WEBHOOK_DELIVERY …)', example: 'SERVICE' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('targetType') })
  @MaxLength(30, { message: ValidationMessage.maxLength('targetType', 30) })
  targetType?: string;

  @ApiPropertyOptional({ description: '대상 ID' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('targetId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('targetId', 100) })
  targetId?: string;

  @ApiPropertyOptional({ description: '대상이 속한 서비스 ID' })
  @IsOptional()
  @IsUUID('all', { message: ValidationMessage.uuid('serviceId') })
  serviceId?: string;

  @ApiPropertyOptional({ description: '기록 시각 이상 (ISO 8601)' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: ValidationMessage.dateString('from') })
  from?: string;

  @ApiPropertyOptional({ description: '기록 시각 미만 (ISO 8601)' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: ValidationMessage.dateString('to') })
  to?: string;

  @ApiPropertyOptional({ description: '페이지 크기', default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: ValidationMessage.integer('limit') })
  @Min(1, { message: ValidationMessage.min('limit', 1) })
  @Max(100, { message: ValidationMessage.max('limit', 100) })
  limit?: number;

  @ApiPropertyOptional({ description: '이전 응답의 nextCursor' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('cursor') })
  cursor?: string;
}

/** 감사 로그. before/after에는 기록 시점에 이미 비밀값이 빠져 있다 */
export class AuditLogResponseDto {
  @ApiProperty() adminAuditLogId: string;
  @ApiProperty({ description: '작업한 관리자 ID' }) actorId: string;
  @ApiProperty({ nullable: true, type: String }) actorName: string | null;
  @ApiProperty({ enum: ACTIONS }) action: string;
  @ApiProperty() targetType: string;
  @ApiProperty() targetId: string;
  @ApiProperty({ nullable: true, type: String }) serviceId: string | null;
  @ApiProperty({ nullable: true, type: Object }) before: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: Object }) after: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: String }) reason: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'admin 레포 요청 ID' }) requestId: string | null;
  @ApiProperty({ nullable: true, type: String }) ip: string | null;
  @ApiProperty() createdAt: Date;

  static from(log: AdminAuditLog): AuditLogResponseDto {
    return Object.assign(new AuditLogResponseDto(), {
      adminAuditLogId: log.adminAuditLogId,
      actorId: log.actorId,
      actorName: log.actorName,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      serviceId: log.serviceId,
      before: log.before,
      after: log.after,
      reason: log.reason,
      requestId: log.requestId,
      ip: log.ip,
      createdAt: log.createdAt,
    });
  }
}

export class AuditLogPageResponseDto {
  @ApiProperty({ type: [AuditLogResponseDto] }) data: AuditLogResponseDto[];
  @ApiProperty() totalCount: number;
  @ApiProperty({ nullable: true, type: String }) nextCursor: string | null;
}
