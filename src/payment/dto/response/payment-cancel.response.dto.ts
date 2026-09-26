import { ApiProperty } from '@nestjs/swagger';
import type { Order } from '../../../order/domain/order.entity';
import { PaymentCancelStatus } from '../../constants/payment.constants';
import { PaymentCancel } from '../../domain/payment-cancel.entity';
import { Payment } from '../../domain/payment.entity';
import { PaymentResponseDto } from './payment.response.dto';

export class PaymentCancelItemResponseDto {
  @ApiProperty({ description: '주문 항목 ID' })
  orderItemId: string;

  @ApiProperty({ description: '취소 수량', example: 1 })
  quantity: number;

  @ApiProperty({ description: '항목 환불 금액', example: 3000 })
  amount: number;
}

/** 취소(환불) 건. 토스 거래 키·환불 계좌 같은 내부·개인 정보는 넣지 않는다 */
export class PaymentCancelResponseDto {
  @ApiProperty({ description: '취소 ID' })
  paymentCancelId: string;

  @ApiProperty({ description: '취소 상태', enum: Object.values(PaymentCancelStatus), example: 'DONE' })
  status: PaymentCancelStatus;

  @ApiProperty({ description: '환불 금액', example: 3000 })
  amount: number;

  @ApiProperty({ description: '서비스 정의 사유 코드', example: 'USER_REQUEST' })
  reasonCode: string;

  @ApiProperty({ description: '사유 설명', nullable: true, type: String, example: '저장공간 1개 환불' })
  reasonDetail: string | null;

  @ApiProperty({ description: '요청 주체', example: 'SERVICE' })
  requestedBy: string;

  @ApiProperty({ type: [PaymentCancelItemResponseDto] })
  items: PaymentCancelItemResponseDto[];

  @ApiProperty({ description: '실패 사유 (FAILED일 때 토스 원본)', nullable: true, type: Object })
  failure: { code: string; message: string } | null;

  @ApiProperty({ description: '환불 확정 시각', nullable: true, type: Date })
  canceledAt: Date | null;

  @ApiProperty({ description: '요청 시각' })
  createdAt: Date;

  static from(cancel: PaymentCancel): PaymentCancelResponseDto {
    return Object.assign(new PaymentCancelResponseDto(), {
      paymentCancelId: cancel.paymentCancelId,
      status: cancel.status,
      amount: cancel.amount,
      reasonCode: cancel.reasonCode,
      reasonDetail: cancel.reasonDetail,
      requestedBy: cancel.requestedBy,
      items: (cancel.items ?? []).map(({ orderItemId, quantity, amount }) =>
        Object.assign(new PaymentCancelItemResponseDto(), { orderItemId, quantity, amount }),
      ),
      failure: cancel.failureCode ? { code: cancel.failureCode, message: cancel.failureMessage ?? '' } : null,
      canceledAt: cancel.canceledAt,
      createdAt: cancel.createdAt,
    });
  }
}

/** 환불 응답: 이번 취소 건 + 갱신된 결제 */
export class CancelPaymentResponseDto {
  @ApiProperty({ type: PaymentCancelResponseDto })
  cancel: PaymentCancelResponseDto;

  @ApiProperty({ type: PaymentResponseDto })
  payment: PaymentResponseDto;

  static from(cancel: PaymentCancel, payment: Payment, order: Order): CancelPaymentResponseDto {
    return Object.assign(new CancelPaymentResponseDto(), {
      cancel: PaymentCancelResponseDto.from(cancel),
      payment: PaymentResponseDto.from(payment, order),
    });
  }
}

/** 결제 단건: 결제 + 취소 이력 (오래된 순) */
export class PaymentDetailResponseDto extends PaymentResponseDto {
  @ApiProperty({ type: [PaymentCancelResponseDto], description: '취소(환불) 이력, 오래된 순' })
  cancels: PaymentCancelResponseDto[];

  static fromDetail(payment: Payment, order: Order): PaymentDetailResponseDto {
    return Object.assign(new PaymentDetailResponseDto(), PaymentResponseDto.from(payment, order), {
      cancels: [...(payment.cancels ?? [])]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((cancel) => PaymentCancelResponseDto.from(cancel)),
    });
  }
}
