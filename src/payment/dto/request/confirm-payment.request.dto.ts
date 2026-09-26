import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';
import { ValidationMessage } from '../../../common/utils/validation-message.util';

/** 토스 결제창 successUrl로 받은 값을 그대로 전달한다 */
export class ConfirmPaymentRequestDto {
  @ApiProperty({ description: 'hub 주문 ID (결제창에 넘긴 orderId)', example: '3f1a0000-0000-4000-8000-000000000001' })
  @IsUUID('all', { message: ValidationMessage.uuid('orderId') })
  orderId: string;

  @ApiProperty({ description: '토스 paymentKey (successUrl 쿼리)', example: 'tgen_20260927101500abcde' })
  @IsString({ message: ValidationMessage.string('paymentKey') })
  @IsNotEmpty({ message: ValidationMessage.required('paymentKey') })
  @MaxLength(200, { message: ValidationMessage.maxLength('paymentKey', 200) })
  paymentKey: string;

  @ApiProperty({ description: '결제 금액 (successUrl 쿼리). 주문 결제 금액과 다르면 거부', example: 30000 })
  @IsInt({ message: ValidationMessage.integer('amount') })
  @IsPositive({ message: ValidationMessage.positive('amount') })
  amount: number;
}
