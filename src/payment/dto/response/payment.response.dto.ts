import { ApiProperty } from '@nestjs/swagger';
import type { Order } from '../../../order/domain/order.entity';
import { CardType, PaymentMethodType, PaymentStatus, PaymentType } from '../../constants/payment.constants';
import { Payment } from '../../domain/payment.entity';

/** 결제 수단 분류. 해당 수단이 아닌 필드는 null */
export class PaymentMethodResponseDto {
  @ApiProperty({ description: '수단 분류', enum: Object.values(PaymentMethodType), nullable: true, example: 'CARD' })
  type: PaymentMethodType | null;

  @ApiProperty({ description: '토스 method 원문', nullable: true, type: String, example: '카드' })
  raw: string | null;

  @ApiProperty({ description: '토스 카드사 코드 (issuerCode)', nullable: true, type: String, example: '11' })
  cardCompanyCode: string | null;

  @ApiProperty({ description: '카드 종류', enum: Object.values(CardType), nullable: true, example: 'CREDIT' })
  cardType: CardType | null;

  @ApiProperty({ description: '마스킹된 카드 번호', nullable: true, type: String, example: '433012******123*' })
  cardNumberMasked: string | null;

  @ApiProperty({ description: '할부 개월 (0 = 일시불)', nullable: true, type: Number, example: 0 })
  installmentMonths: number | null;

  @ApiProperty({ description: '간편결제사 (토스 원문)', nullable: true, type: String, example: '토스페이' })
  easyPayProvider: string | null;

  @ApiProperty({ description: '은행 코드 (가상계좌·계좌이체)', nullable: true, type: String, example: '20' })
  bankCode: string | null;

  @ApiProperty({ description: '가상계좌 번호', nullable: true, type: String, example: 'X6505636518308' })
  virtualAccountNumber: string | null;

  @ApiProperty({ description: '가상계좌 입금 기한', nullable: true, type: Date })
  virtualAccountDueAt: Date | null;

  static from(payment: Payment): PaymentMethodResponseDto {
    return Object.assign(new PaymentMethodResponseDto(), {
      type: payment.methodType,
      raw: payment.method,
      cardCompanyCode: payment.cardCompanyCode,
      cardType: payment.cardType,
      cardNumberMasked: payment.cardNumberMasked,
      installmentMonths: payment.installmentMonths,
      easyPayProvider: payment.easyPayProvider,
      bankCode: payment.bankCode,
      virtualAccountNumber: payment.virtualAccountNumber,
      virtualAccountDueAt: payment.virtualAccountDueAt,
    });
  }
}

export class PaymentFailureResponseDto {
  @ApiProperty({ description: '토스 원본 에러 코드', example: 'REJECT_CARD_PAYMENT' })
  code: string;

  @ApiProperty({
    description: '토스 원본 메시지 (사용자에게 보여줄 수 있음)',
    example: '한도초과 혹은 잔액부족으로 결제에 실패했습니다.',
  })
  message: string;
}

/**
 * 서비스 응답용 결제. PG 응답 원본(provider_response)·원장·대사 내부 정보는 넣지 않는다.
 * 서비스가 자기 주문과 연결할 수 있게 주문의 외부 ID를 함께 준다.
 */
export class PaymentResponseDto {
  @ApiProperty({ description: '결제 ID', example: 'a9d20000-0000-4000-8000-000000000001' })
  paymentId: string;

  @ApiProperty({ description: 'hub 주문 ID', example: '3f1a0000-0000-4000-8000-000000000001' })
  orderId: string;

  @ApiProperty({ description: '서비스 쪽 주문번호', example: 'svc-a-order-20260927-0001' })
  externalOrderId: string;

  @ApiProperty({ description: '서비스 쪽 사용자 ID', example: 'user-123' })
  externalUserId: string;

  @ApiProperty({ description: '주문명', example: '프로 요금제 1개월' })
  orderName: string;

  @ApiProperty({ description: '결제 유형', enum: Object.values(PaymentType), example: 'NORMAL' })
  paymentType: PaymentType;

  @ApiProperty({ description: '결제 상태', enum: Object.values(PaymentStatus), example: 'DONE' })
  status: PaymentStatus;

  @ApiProperty({ description: '결제 금액', example: 30000 })
  amount: number;

  @ApiProperty({ description: '환불 누적 금액', example: 0 })
  refundedAmount: number;

  @ApiProperty({ description: '환불 가능 금액 (승인 전·실패 결제는 0)', example: 30000 })
  refundableAmount: number;

  @ApiProperty({ description: '통화', example: 'KRW' })
  currency: string;

  @ApiProperty({
    type: PaymentMethodResponseDto,
    description: '결제 수단. 승인 전(IN_PROGRESS·UNKNOWN)에는 필드가 모두 null',
  })
  method: PaymentMethodResponseDto;

  @ApiProperty({ description: '영수증 URL', nullable: true, type: String })
  receiptUrl: string | null;

  @ApiProperty({ description: '승인 시각', nullable: true, type: Date })
  approvedAt: Date | null;

  @ApiProperty({ type: PaymentFailureResponseDto, nullable: true, description: '실패 사유 (FAILED일 때)' })
  failure: PaymentFailureResponseDto | null;

  @ApiProperty({ description: '결제 시도 시각', example: '2026-09-27T01:15:00.000Z' })
  createdAt: Date;

  static from(payment: Payment, order: Order): PaymentResponseDto {
    return Object.assign(new PaymentResponseDto(), {
      paymentId: payment.paymentId,
      orderId: payment.orderId,
      externalOrderId: order.externalOrderId,
      externalUserId: order.externalUserId,
      orderName: order.orderName,
      paymentType: payment.paymentType,
      status: payment.status,
      amount: payment.amount,
      refundedAmount: payment.refundedAmount,
      refundableAmount: payment.refundableAmount,
      currency: payment.currency,
      method: PaymentMethodResponseDto.from(payment),
      receiptUrl: payment.receiptUrl,
      approvedAt: payment.approvedAt,
      failure: payment.failureCode ? { code: payment.failureCode, message: payment.failureMessage ?? '' } : null,
      createdAt: payment.createdAt,
    });
  }
}

export class PaymentPageResponseDto {
  @ApiProperty({ type: [PaymentResponseDto] })
  data: PaymentResponseDto[];

  @ApiProperty({ description: '필터에 맞는 전체 개수', example: 4 })
  totalCount: number;

  @ApiProperty({ description: '다음 페이지 cursor. 마지막이면 null', nullable: true, type: String })
  nextCursor: string | null;
}
