import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ValidationMessage } from '../../../common/utils/validation-message.util';
import { CreateOrderParams } from '../../domain/order.entity';

export const DEFAULT_ORDER_TTL_SECONDS = 1800;
const MIN_ORDER_TTL_SECONDS = 60;
const MAX_ORDER_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_ITEMS = 100;

export class OrderItemRequestDto {
  @ApiProperty({ description: '상품 유형 코드. 관리자가 등록한 활성 유형만 허용', example: 'PLAN' })
  @IsString({ message: ValidationMessage.string('productType') })
  @IsNotEmpty({ message: ValidationMessage.required('productType') })
  @MaxLength(50, { message: ValidationMessage.maxLength('productType', 50) })
  productType: string;

  @ApiProperty({ description: '서비스 쪽 상품 ID', example: 'pro-monthly' })
  @IsString({ message: ValidationMessage.string('externalProductId') })
  @IsNotEmpty({ message: ValidationMessage.required('externalProductId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('externalProductId', 100) })
  externalProductId: string;

  @ApiProperty({ description: '상품명 (결제 시점 스냅샷)', example: '프로 요금제 1개월' })
  @IsString({ message: ValidationMessage.string('productName') })
  @IsNotEmpty({ message: ValidationMessage.required('productName') })
  @MaxLength(100, { message: ValidationMessage.maxLength('productName', 100) })
  productName: string;

  @ApiProperty({ description: '단가 (통화 최소 단위, 정수)', example: 29000 })
  @IsInt({ message: ValidationMessage.integer('unitPrice') })
  @Min(0, { message: ValidationMessage.min('unitPrice', 0) })
  unitPrice: number;

  @ApiProperty({ description: '수량', example: 1 })
  @IsInt({ message: ValidationMessage.integer('quantity') })
  @Min(1, { message: ValidationMessage.min('quantity', 1) })
  quantity: number;
}

export class CreateOrderRequestDto {
  @ApiProperty({
    description: '서비스 쪽 주문번호. (서비스, externalOrderId)가 주문 등록 멱등키',
    example: 'svc-a-order-20260927-0001',
  })
  @IsString({ message: ValidationMessage.string('externalOrderId') })
  @IsNotEmpty({ message: ValidationMessage.required('externalOrderId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('externalOrderId', 100) })
  externalOrderId: string;

  @ApiProperty({ description: '서비스 쪽 사용자 ID', example: 'user-123' })
  @IsString({ message: ValidationMessage.string('externalUserId') })
  @IsNotEmpty({ message: ValidationMessage.required('externalUserId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('externalUserId', 100) })
  externalUserId: string;

  @ApiPropertyOptional({ description: '구독 ID (정기결제 체인 조회용)', example: 'sub-77' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('externalSubscriptionId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('externalSubscriptionId', 100) })
  externalSubscriptionId?: string;

  @ApiProperty({ description: '토스 결제창에 표시되는 주문명', example: '프로 요금제 1개월 외 1건' })
  @IsString({ message: ValidationMessage.string('orderName') })
  @IsNotEmpty({ message: ValidationMessage.required('orderName') })
  @MaxLength(100, { message: ValidationMessage.maxLength('orderName', 100) })
  orderName: string;

  @ApiPropertyOptional({ description: '통화 (ISO 4217)', example: 'KRW', default: 'KRW' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: ValidationMessage.format('currency', 'ISO 4217 대문자 3자리') })
  currency?: string;

  @ApiProperty({ description: `주문 항목 (1~${MAX_ITEMS}개)`, type: [OrderItemRequestDto] })
  @IsArray({ message: ValidationMessage.required('items') })
  @ArrayMinSize(1, { message: ValidationMessage.min('items 개수', 1) })
  @ArrayMaxSize(MAX_ITEMS, { message: ValidationMessage.max('items 개수', MAX_ITEMS) })
  @ValidateNested({ each: true })
  @Type(() => OrderItemRequestDto)
  items: OrderItemRequestDto[];

  @ApiPropertyOptional({ description: '할인 종류 (서비스 정의 값, hub는 저장만)', example: 'COUPON_WELCOME' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('discountType') })
  @MaxLength(50, { message: ValidationMessage.maxLength('discountType', 50) })
  discountType?: string;

  @ApiPropertyOptional({ description: '할인 금액', example: 5000, default: 0 })
  @IsOptional()
  @IsInt({ message: ValidationMessage.integer('discountAmount') })
  @Min(0, { message: ValidationMessage.min('discountAmount', 0) })
  discountAmount?: number;

  @ApiProperty({ description: '실제 결제 금액 = 항목 합계 − 할인. 결제 승인 시 이 금액과 대조', example: 30000 })
  @IsInt({ message: ValidationMessage.integer('totalAmount') })
  @IsPositive({ message: ValidationMessage.positive('totalAmount') })
  totalAmount: number;

  @ApiPropertyOptional({
    description: `결제 가능 시간(초). 이후 결제 승인은 ORDER_EXPIRED`,
    example: DEFAULT_ORDER_TTL_SECONDS,
    default: DEFAULT_ORDER_TTL_SECONDS,
    minimum: MIN_ORDER_TTL_SECONDS,
    maximum: MAX_ORDER_TTL_SECONDS,
  })
  @IsOptional()
  @IsInt({ message: ValidationMessage.integer('expiresInSeconds') })
  @Min(MIN_ORDER_TTL_SECONDS, { message: ValidationMessage.min('expiresInSeconds', MIN_ORDER_TTL_SECONDS) })
  @Max(MAX_ORDER_TTL_SECONDS, { message: ValidationMessage.max('expiresInSeconds', MAX_ORDER_TTL_SECONDS) })
  expiresInSeconds?: number;

  @ApiPropertyOptional({ description: '서비스 맥락 (hub는 해석하지 않음)', example: { plan: 'pro' } })
  @IsOptional()
  @IsObject({ message: ValidationMessage.format('metadata', 'JSON 객체') })
  metadata?: Record<string, unknown>;

  toParams(serviceId: string, now: Date): CreateOrderParams {
    return {
      serviceId,
      externalOrderId: this.externalOrderId,
      externalUserId: this.externalUserId,
      externalSubscriptionId: this.externalSubscriptionId,
      orderName: this.orderName,
      currency: this.currency ?? 'KRW',
      items: this.items.map(({ productType, externalProductId, productName, unitPrice, quantity }) => ({
        productType,
        externalProductId,
        productName,
        unitPrice,
        quantity,
      })),
      discountType: this.discountType,
      discountAmount: this.discountAmount,
      totalAmount: this.totalAmount,
      expiresAt: new Date(now.getTime() + (this.expiresInSeconds ?? DEFAULT_ORDER_TTL_SECONDS) * 1000),
      metadata: this.metadata,
    };
  }
}
