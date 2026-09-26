import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';
import { ValidationMessage } from '../../../common/utils/validation-message.util';

export class BillingPaymentRequestDto {
  @ApiProperty({ description: '미리 등록한 주문 ID', example: '5b7c0000-0000-4000-8000-000000000001' })
  @IsUUID('all', { message: ValidationMessage.uuid('orderId') })
  orderId: string;

  @ApiProperty({ description: '결제 수단 ID (POST /billing-keys 응답). 주문의 사용자와 같은 사용자의 활성 수단' })
  @IsUUID('all', { message: ValidationMessage.uuid('billingKeyId') })
  billingKeyId: string;

  @ApiProperty({ description: '결제 금액. 주문 결제 금액과 같아야 한다', example: 29000 })
  @IsInt({ message: ValidationMessage.integer('amount') })
  @IsPositive({ message: ValidationMessage.positive('amount') })
  amount: number;

  @ApiProperty({
    description: '멱등키 (최대 90자). 재시도에도 같은 값 — 예: 구독ID-결제회차',
    example: 'svc-a-billing-sub-77-2026-10',
  })
  @IsString({ message: ValidationMessage.string('idempotencyKey') })
  @IsNotEmpty({ message: ValidationMessage.required('idempotencyKey') })
  @MaxLength(90, { message: ValidationMessage.maxLength('idempotencyKey', 90) })
  idempotencyKey: string;
}
