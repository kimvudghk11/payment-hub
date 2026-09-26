import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ValidationMessage } from '../../../common/utils/validation-message.util';
import { PaymentMethodType, PaymentStatus } from '../../constants/payment.constants';

const PAYMENT_STATUSES = Object.values(PaymentStatus);
const METHOD_TYPES = Object.values(PaymentMethodType);

export class ListPaymentsQueryDto {
  @ApiPropertyOptional({ description: '서비스 쪽 사용자 ID — 서비스 + 사용자 단위 결제 이력', example: 'user-123' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('externalUserId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('externalUserId', 100) })
  externalUserId?: string;

  @ApiPropertyOptional({ description: '서비스 쪽 주문번호', example: 'svc-a-order-20260927-0001' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('externalOrderId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('externalOrderId', 100) })
  externalOrderId?: string;

  @ApiPropertyOptional({ description: '구독 ID — 구독 결제 체인 (일할 환불 계산용)', example: 'sub-77' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('externalSubscriptionId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('externalSubscriptionId', 100) })
  externalSubscriptionId?: string;

  @ApiPropertyOptional({
    description: `결제 상태. 쉼표로 여러 개 (${PAYMENT_STATUSES.join(', ')})`,
    example: 'DONE,PARTIAL_CANCELED',
    type: String,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((status) => status.trim())
          .filter(Boolean)
      : value,
  )
  @IsIn(PAYMENT_STATUSES, { each: true, message: ValidationMessage.oneOf('status', PAYMENT_STATUSES) })
  status?: PaymentStatus[];

  @ApiPropertyOptional({ description: '결제 수단 분류', enum: METHOD_TYPES })
  @IsOptional()
  @IsIn(METHOD_TYPES, { message: ValidationMessage.oneOf('methodType', METHOD_TYPES) })
  methodType?: PaymentMethodType;

  @ApiPropertyOptional({ description: '결제 시도 시각 이상 (ISO 8601)', example: '2026-09-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: ValidationMessage.dateString('from') })
  from?: string;

  @ApiPropertyOptional({ description: '결제 시도 시각 미만 (ISO 8601)', example: '2026-10-01T00:00:00.000Z' })
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
