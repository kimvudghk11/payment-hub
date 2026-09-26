import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../../constants/order.constants';
import { OrderItem } from '../../domain/order-item.entity';
import { Order } from '../../domain/order.entity';

export class OrderItemResponseDto {
  @ApiProperty({ description: '주문 항목 ID (부분 환불 시 지정)', example: 'c1a2...' })
  orderItemId: string;

  @ApiProperty({ description: '항목 순번', example: 1 })
  lineNo: number;

  @ApiProperty({ description: '상품 유형', example: 'PLAN' })
  productType: string;

  @ApiProperty({ description: '서비스 쪽 상품 ID', example: 'pro-monthly' })
  externalProductId: string;

  @ApiProperty({ description: '상품명', example: '프로 요금제 1개월' })
  productName: string;

  @ApiProperty({ description: '단가', example: 29000 })
  unitPrice: number;

  @ApiProperty({ description: '수량', example: 1 })
  quantity: number;

  @ApiProperty({ description: '금액 = 단가 × 수량', example: 29000 })
  amount: number;

  @ApiProperty({ description: '취소된 수량', example: 0 })
  canceledQuantity: number;

  static from(item: OrderItem): OrderItemResponseDto {
    return Object.assign(new OrderItemResponseDto(), {
      orderItemId: item.orderItemId,
      lineNo: item.lineNo,
      productType: item.productType,
      externalProductId: item.externalProductId,
      productName: item.productName,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      amount: item.amount,
      canceledQuantity: item.canceledQuantity,
    });
  }
}

/** 목록용 요약 (항목 제외) */
export class OrderSummaryResponseDto {
  @ApiProperty({ description: '주문 ID. 토스 결제창의 orderId로 사용', example: '3f1a...' })
  orderId: string;

  @ApiProperty({ description: '서비스 쪽 주문번호', example: 'svc-a-order-20260927-0001' })
  externalOrderId: string;

  @ApiProperty({ description: '서비스 쪽 사용자 ID', example: 'user-123' })
  externalUserId: string;

  @ApiProperty({ description: '구독 ID', nullable: true, type: String, example: 'sub-77' })
  externalSubscriptionId: string | null;

  @ApiProperty({ description: '주문명', example: '프로 요금제 1개월 외 1건' })
  orderName: string;

  @ApiProperty({ description: '통화', example: 'KRW' })
  currency: string;

  @ApiProperty({ description: '항목 합계', example: 35000 })
  originalAmount: number;

  @ApiProperty({ description: '할인 종류', nullable: true, type: String, example: 'COUPON_WELCOME' })
  discountType: string | null;

  @ApiProperty({ description: '할인 금액', example: 5000 })
  discountAmount: number;

  @ApiProperty({ description: '결제 금액. 결제 승인 시 이 값과 대조', example: 30000 })
  totalAmount: number;

  @ApiProperty({ description: '주문 상태', enum: Object.values(OrderStatus), example: OrderStatus.PENDING })
  status: OrderStatus;

  @ApiProperty({ description: '결제 가능 기한', example: '2026-09-27T01:30:00.000Z' })
  expiresAt: Date;

  @ApiProperty({ description: '결제 완료 시각', nullable: true, type: Date })
  paidAt: Date | null;

  @ApiProperty({ description: '서비스 맥락', nullable: true, type: Object, example: { plan: 'pro' } })
  metadata: Record<string, unknown> | null;

  @ApiProperty({ description: '등록 시각', example: '2026-09-27T01:00:00.000Z' })
  createdAt: Date;

  static from(order: Order): OrderSummaryResponseDto {
    return Object.assign(new OrderSummaryResponseDto(), OrderSummaryResponseDto.fieldsOf(order));
  }

  protected static fieldsOf(order: Order) {
    return {
      orderId: order.orderId,
      externalOrderId: order.externalOrderId,
      externalUserId: order.externalUserId,
      externalSubscriptionId: order.externalSubscriptionId,
      orderName: order.orderName,
      currency: order.currency,
      originalAmount: order.originalAmount,
      discountType: order.discountType,
      discountAmount: order.discountAmount,
      totalAmount: order.totalAmount,
      status: order.status,
      expiresAt: order.expiresAt,
      paidAt: order.paidAt,
      metadata: order.metadata,
      createdAt: order.createdAt,
    };
  }
}

/** 단건 (항목 포함) */
export class OrderResponseDto extends OrderSummaryResponseDto {
  @ApiProperty({ type: [OrderItemResponseDto] })
  items: OrderItemResponseDto[];

  static override from(order: Order): OrderResponseDto {
    return Object.assign(new OrderResponseDto(), OrderSummaryResponseDto.fieldsOf(order), {
      items: [...order.items].sort((a, b) => a.lineNo - b.lineNo).map((item) => OrderItemResponseDto.from(item)),
    });
  }
}

export class OrderPageResponseDto {
  @ApiProperty({ type: [OrderSummaryResponseDto] })
  data: OrderSummaryResponseDto[];

  @ApiProperty({ description: '필터에 맞는 전체 개수', example: 3 })
  totalCount: number;

  @ApiProperty({ description: '다음 페이지 cursor. 마지막이면 null', nullable: true, type: String })
  nextCursor: string | null;
}
