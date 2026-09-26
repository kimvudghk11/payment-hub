import { ApiProperty } from '@nestjs/swagger';
import { OrderItem } from '../../../order/domain/order-item.entity';
import { PaymentStatus } from '../../constants/payment.constants';
import { Payment } from '../../domain/payment.entity';

export class RefundableItemResponseDto {
  @ApiProperty({
    description: '주문 항목 ID (부분 환불 시 items[].orderItemId로 지정)',
    example: 'c1a20000-0000-4000-8000-000000000001',
  })
  orderItemId: string;

  @ApiProperty({ description: '상품명', example: '추가 저장공간 10GB' })
  productName: string;

  @ApiProperty({ description: '단가', example: 3000 })
  unitPrice: number;

  @ApiProperty({ description: '수량', example: 2 })
  quantity: number;

  @ApiProperty({ description: '이미 취소된 수량', example: 1 })
  canceledQuantity: number;

  @ApiProperty({ description: '더 취소할 수 있는 수량 (환불 불가 결제면 0)', example: 1 })
  cancelableQuantity: number;
}

/** 환불 가능 금액. 금액 계산(일할 등)은 서비스가 하고, hub는 상한과 항목 수량만 알려준다 */
export class RefundableResponseDto {
  @ApiProperty({ description: '결제 ID' })
  paymentId: string;

  @ApiProperty({ description: '결제 상태', enum: Object.values(PaymentStatus), example: 'PARTIAL_CANCELED' })
  status: PaymentStatus;

  @ApiProperty({ description: '결제 금액', example: 30000 })
  amount: number;

  @ApiProperty({ description: '환불 누적 금액', example: 3000 })
  refundedAmount: number;

  @ApiProperty({ description: '환불 가능 금액 — 환불 요청 amount의 상한', example: 27000 })
  refundableAmount: number;

  @ApiProperty({ type: [RefundableItemResponseDto] })
  items: RefundableItemResponseDto[];

  static from(payment: Payment, items: OrderItem[]): RefundableResponseDto {
    const refundable = payment.refundableAmount > 0;
    return Object.assign(new RefundableResponseDto(), {
      paymentId: payment.paymentId,
      status: payment.status,
      amount: payment.amount,
      refundedAmount: payment.refundedAmount,
      refundableAmount: payment.refundableAmount,
      items: [...items]
        .sort((a, b) => a.lineNo - b.lineNo)
        .map((item) =>
          Object.assign(new RefundableItemResponseDto(), {
            orderItemId: item.orderItemId,
            productName: item.productName,
            unitPrice: item.unitPrice,
            quantity: item.quantity,
            canceledQuantity: item.canceledQuantity,
            cancelableQuantity: refundable ? item.quantity - item.canceledQuantity : 0,
          }),
        ),
    });
  }
}
