import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { ValidationMessage } from '../../../../common/utils/validation-message.util';
import { WebhookDeliveryStatus } from '../../../../outbox/constants/outbox.constants';

const DELIVERY_STATUSES = Object.values(WebhookDeliveryStatus);

export class ListWebhookDeliveriesQueryDto {
  @ApiPropertyOptional({ description: '전달 상태 (실패 큐는 DEAD)', enum: DELIVERY_STATUSES })
  @IsOptional()
  @IsIn(DELIVERY_STATUSES, { message: ValidationMessage.oneOf('status', DELIVERY_STATUSES) })
  status?: WebhookDeliveryStatus;

  @ApiPropertyOptional({ description: '서비스 ID' })
  @IsOptional()
  @IsUUID('all', { message: ValidationMessage.uuid('serviceId') })
  serviceId?: string;

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

export class ListUnknownPaymentsQueryDto {
  @ApiPropertyOptional({ description: '서비스 ID' })
  @IsOptional()
  @IsUUID('all', { message: ValidationMessage.uuid('serviceId') })
  serviceId?: string;

  @ApiPropertyOptional({ description: '최대 개수 (오래된 순)', default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: ValidationMessage.integer('limit') })
  @Min(1, { message: ValidationMessage.min('limit', 1) })
  @Max(200, { message: ValidationMessage.max('limit', 200) })
  limit?: number;
}
