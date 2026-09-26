import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ValidationMessage } from '../../../common/utils/validation-message.util';
import { CancelRequestedBy } from '../../constants/payment.constants';
import { CancelRequest } from '../../domain/payment.entity';

export class CancelItemRequestDto {
  @ApiProperty({ description: '주문 항목 ID (GET /payments/:id/refundable의 items[].orderItemId)' })
  @IsUUID('all', { message: ValidationMessage.uuid('orderItemId') })
  orderItemId: string;

  @ApiProperty({ description: '취소 수량', example: 1 })
  @IsInt({ message: ValidationMessage.integer('quantity') })
  @IsPositive({ message: ValidationMessage.positive('quantity') })
  quantity: number;

  @ApiProperty({ description: '이 항목의 환불 금액. 항목 합계 = amount', example: 3000 })
  @IsInt({ message: ValidationMessage.integer('amount') })
  @Min(0, { message: ValidationMessage.min('amount', 0) })
  amount: number;
}

/** 가상계좌 환불 계좌. 토스에 전달만 하고 hub는 저장하지 않는다 */
export class RefundReceiveAccountRequestDto {
  @ApiProperty({ description: '토스 은행 코드', example: '20' })
  @IsString({ message: ValidationMessage.string('bankCode') })
  @Matches(/^\d{2,3}$/, { message: ValidationMessage.format('bankCode', '숫자 2~3자리') })
  bankCode: string;

  @ApiProperty({ description: '계좌번호 (숫자만)', example: '1002123456789' })
  @IsString({ message: ValidationMessage.string('accountNumber') })
  @Matches(/^\d{6,20}$/, { message: ValidationMessage.format('accountNumber', '숫자 6~20자리') })
  accountNumber: string;

  @ApiProperty({ description: '예금주', example: '홍길동' })
  @IsString({ message: ValidationMessage.string('holderName') })
  @IsNotEmpty({ message: ValidationMessage.required('holderName') })
  @MaxLength(60, { message: ValidationMessage.maxLength('holderName', 60) })
  holderName: string;
}

export class CancelPaymentRequestDto {
  @ApiProperty({ description: '환불 금액. 계산(일할 등)은 서비스 책임, 상한은 환불 가능 금액', example: 3000 })
  @IsInt({ message: ValidationMessage.integer('amount') })
  @IsPositive({ message: ValidationMessage.positive('amount') })
  amount: number;

  @ApiProperty({ description: '서비스 정의 사유 코드 (hub는 저장만)', example: 'USER_REQUEST' })
  @IsString({ message: ValidationMessage.string('reasonCode') })
  @IsNotEmpty({ message: ValidationMessage.required('reasonCode') })
  @MaxLength(50, { message: ValidationMessage.maxLength('reasonCode', 50) })
  reasonCode: string;

  @ApiPropertyOptional({
    description: '사유 설명. 토스 cancelReason으로 전달 (없으면 reasonCode)',
    example: '저장공간 1개 환불',
  })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('reasonDetail') })
  @MaxLength(200, { message: ValidationMessage.maxLength('reasonDetail', 200) })
  reasonDetail?: string;

  @ApiProperty({ description: '멱등키. 재시도 시 같은 값 → 같은 결과', example: 'svc-a-refund-0001' })
  @IsString({ message: ValidationMessage.string('idempotencyKey') })
  @IsNotEmpty({ message: ValidationMessage.required('idempotencyKey') })
  @MaxLength(100, { message: ValidationMessage.maxLength('idempotencyKey', 100) })
  idempotencyKey: string;

  @ApiPropertyOptional({ type: [CancelItemRequestDto], description: '항목별 취소 기록 (부분 환불 추적용)' })
  @IsOptional()
  @IsArray({ message: ValidationMessage.required('items') })
  @ArrayMaxSize(100, { message: ValidationMessage.max('items 개수', 100) })
  @ValidateNested({ each: true })
  @Type(() => CancelItemRequestDto)
  items?: CancelItemRequestDto[];

  @ApiPropertyOptional({ type: RefundReceiveAccountRequestDto, description: '가상계좌 결제만 필수' })
  @IsOptional()
  @ValidateNested()
  @Type(() => RefundReceiveAccountRequestDto)
  refundReceiveAccount?: RefundReceiveAccountRequestDto;

  toRequest(): CancelRequest {
    return {
      idempotencyKey: this.idempotencyKey,
      amount: this.amount,
      reasonCode: this.reasonCode,
      reasonDetail: this.reasonDetail ?? null,
      requestedBy: CancelRequestedBy.SERVICE,
      items: (this.items ?? []).map(({ orderItemId, quantity, amount }) => ({ orderItemId, quantity, amount })),
    };
  }
}
