import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LedgerService } from '../ledger/ledger.service';
import { Order } from '../order/domain/order.entity';
import { OutboxEventType } from '../outbox/constants/outbox.constants';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentStatus } from './constants/payment.constants';
import { Payment } from './domain/payment.entity';

/**
 * 결제 상태가 정해진 뒤의 후속 기록 — 주문 상태, 원장, outbox 이벤트.
 * 승인(confirm)과 대사(reconcile)가 같은 규칙을 쓴다. 호출한 쪽의 트랜잭션 안에서 실행된다.
 * UNKNOWN은 아직 결과가 아니므로 아무것도 남기지 않는다.
 */
@Injectable()
export class PaymentOutcomeService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
  ) {}

  async record(payment: Payment, order: Order): Promise<void> {
    switch (payment.status) {
      case PaymentStatus.DONE:
        order.markPaid(payment.approvedAt ?? new Date());
        await this.orders.save(order);
        await this.ledger.recordPaymentCaptured(payment);
        await this.outbox.publishPaymentEvent(OutboxEventType.PAYMENT_CONFIRMED, payment, order);
        return;
      case PaymentStatus.WAITING_FOR_DEPOSIT:
        await this.outbox.publishPaymentEvent(OutboxEventType.PAYMENT_WAITING_FOR_DEPOSIT, payment, order);
        return;
      case PaymentStatus.FAILED:
        await this.outbox.publishPaymentEvent(OutboxEventType.PAYMENT_FAILED, payment, order);
        return;
      default:
        return;
    }
  }
}
