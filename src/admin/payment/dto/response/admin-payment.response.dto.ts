import { ApiProperty } from '@nestjs/swagger';
import { LedgerEntry } from '../../../../ledger/domain/ledger-entry.entity';
import { LedgerTransaction } from '../../../../ledger/domain/ledger-transaction.entity';
import { OrderResponseDto } from '../../../../order/dto/response/order.response.dto';
import type { Order } from '../../../../order/domain/order.entity';
import { OutboxEvent } from '../../../../outbox/domain/outbox-event.entity';
import { WebhookDelivery } from '../../../../outbox/domain/webhook-delivery.entity';
import { Payment } from '../../../../payment/domain/payment.entity';
import { PaymentCancelResponseDto } from '../../../../payment/dto/response/payment-cancel.response.dto';
import { PaymentResponseDto } from '../../../../payment/dto/response/payment.response.dto';

/** 관리자용 결제: 서비스 응답 + 어느 서비스인지, 토스 paymentKey (토스 대시보드와 맞춰 보기 위함) */
export class AdminPaymentResponseDto extends PaymentResponseDto {
  @ApiProperty({ description: '서비스 ID' })
  serviceId: string;

  @ApiProperty({ description: '토스 paymentKey', nullable: true, type: String })
  providerPaymentKey: string | null;

  static fromAdmin(payment: Payment, order: Order): AdminPaymentResponseDto {
    return Object.assign(new AdminPaymentResponseDto(), PaymentResponseDto.from(payment, order), {
      serviceId: payment.serviceId,
      providerPaymentKey: payment.providerPaymentKey,
    });
  }
}

export class AdminPaymentPageResponseDto {
  @ApiProperty({ type: [AdminPaymentResponseDto] })
  data: AdminPaymentResponseDto[];

  @ApiProperty({ description: '필터에 맞는 전체 개수' })
  totalCount: number;

  @ApiProperty({ description: '다음 페이지 cursor. 마지막이면 null', nullable: true, type: String })
  nextCursor: string | null;
}

export class AdminLedgerEntryResponseDto {
  @ApiProperty({ description: '계정 코드', example: 'PG_RECEIVABLE' })
  accountCode: string;

  @ApiProperty({ description: '차변·대변', example: 'DEBIT' })
  direction: string;

  @ApiProperty({ description: '금액', example: 30000 })
  amount: number;
}

export class AdminLedgerTransactionResponseDto {
  @ApiProperty({ description: '분개 유형', example: 'PAYMENT_CAPTURED' })
  transactionType: string;

  @ApiProperty({ description: '참조 유형 (PAYMENT / PAYMENT_CANCEL)', example: 'PAYMENT' })
  referenceType: string;

  @ApiProperty({ description: '사건 발생 시각' })
  occurredAt: Date;

  @ApiProperty({ type: [AdminLedgerEntryResponseDto], description: '차변 먼저' })
  entries: AdminLedgerEntryResponseDto[];

  static from(transaction: LedgerTransaction, accountCodes: Map<string, string>): AdminLedgerTransactionResponseDto {
    const order = (entry: LedgerEntry) => (entry.direction === 'DEBIT' ? 0 : 1);
    return Object.assign(new AdminLedgerTransactionResponseDto(), {
      transactionType: transaction.transactionType,
      referenceType: transaction.referenceType,
      occurredAt: transaction.occurredAt,
      entries: [...transaction.entries]
        .sort((a, b) => order(a) - order(b))
        .map((entry) =>
          Object.assign(new AdminLedgerEntryResponseDto(), {
            accountCode: accountCodes.get(entry.ledgerAccountId) ?? entry.ledgerAccountId,
            direction: entry.direction,
            amount: entry.amount,
          }),
        ),
    });
  }
}

export class AdminWebhookDeliveryResponseDto {
  @ApiProperty({ description: '전달 ID (재전송 시 사용)' })
  webhookDeliveryId: string;

  @ApiProperty({ description: '이벤트 ID (서비스가 받는 X-PaymentHub-Event-Id)' })
  eventId: string;

  @ApiProperty({ description: '이벤트 유형', example: 'PAYMENT_CONFIRMED' })
  eventType: string;

  @ApiProperty({ description: '서비스 ID' })
  serviceId: string;

  @ApiProperty({ description: '전달 상태', example: 'SUCCEEDED' })
  status: string;

  @ApiProperty({ description: '시도 횟수' })
  attemptCount: number;

  @ApiProperty({ description: '다음 시도 시각' })
  nextAttemptAt: Date;

  @ApiProperty({ description: '마지막 HTTP 응답 코드', nullable: true, type: Number })
  lastHttpStatus: number | null;

  @ApiProperty({ description: '마지막 오류', nullable: true, type: String })
  lastError: string | null;

  @ApiProperty({ description: '전달 성공 시각', nullable: true, type: Date })
  deliveredAt: Date | null;

  @ApiProperty({ description: '발행 시점 webhookUrl' })
  targetUrl: string;

  @ApiProperty({ description: '이벤트 발생 시각' })
  occurredAt: Date;

  static from(delivery: WebhookDelivery, event: OutboxEvent): AdminWebhookDeliveryResponseDto {
    return Object.assign(new AdminWebhookDeliveryResponseDto(), {
      webhookDeliveryId: delivery.webhookDeliveryId,
      eventId: event.outboxEventId,
      eventType: event.eventType,
      serviceId: delivery.serviceId,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      nextAttemptAt: delivery.nextAttemptAt,
      lastHttpStatus: delivery.lastHttpStatus,
      lastError: delivery.lastError,
      deliveredAt: delivery.deliveredAt,
      targetUrl: delivery.targetUrl,
      occurredAt: event.occurredAt,
    });
  }
}

/**
 * 결제 상세: 주문·항목, 취소 이력, 원장 분개, 웹훅 전달 내역, PG 응답 원본까지 한 번에 (CS·장애 대응용).
 * 비밀값(시크릿 키, 서명 키, 빌링키)은 이 경로에 없다. PG 응답 원본은 관리자에게만 준다.
 */
export class AdminPaymentDetailResponseDto extends AdminPaymentResponseDto {
  @ApiProperty({ type: OrderResponseDto })
  order: OrderResponseDto;

  @ApiProperty({ type: [PaymentCancelResponseDto] })
  cancels: PaymentCancelResponseDto[];

  @ApiProperty({ type: [AdminLedgerTransactionResponseDto], description: '사건 순' })
  ledger: AdminLedgerTransactionResponseDto[];

  @ApiProperty({ type: [AdminWebhookDeliveryResponseDto], description: '이벤트 순' })
  webhookDeliveries: AdminWebhookDeliveryResponseDto[];

  @ApiProperty({ description: '마지막 PG 응답 원본', nullable: true, type: Object })
  providerResponse: Record<string, unknown> | null;
}
