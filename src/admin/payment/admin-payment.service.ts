import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { IPageable } from '../../common/interceptors/response.interceptor';
import { LedgerAccount } from '../../ledger/domain/ledger-account.entity';
import { LedgerTransaction } from '../../ledger/domain/ledger-transaction.entity';
import { Order } from '../../order/domain/order.entity';
import { OutboxEvent } from '../../outbox/domain/outbox-event.entity';
import { WebhookDelivery } from '../../outbox/domain/webhook-delivery.entity';
import { Payment } from '../../payment/domain/payment.entity';
import { CancelView, PaymentCancelService } from '../../payment/payment-cancel.service';
import { PaymentSearchFilters, searchPayments } from '../../payment/payment-search';
import { AdminActor } from '../../common/types/request-context';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminAuditAction, AuditTargetType } from '../audit/constants/admin-audit.constants';
import { AdminCancelPaymentRequestDto } from './dto/request/admin-cancel-payment.request.dto';

export interface AdminPaymentDetail {
  payment: Payment;
  order: Order;
  ledger: LedgerTransaction[];
  ledgerAccountCodes: Map<string, string>;
  webhookDeliveries: { delivery: WebhookDelivery; event: OutboxEvent }[];
}

/** 관리자 결제 조회. 전 서비스 범위 (조회는 감사 로그를 남기지 않는다) */
@Injectable()
export class AdminPaymentService {
  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(LedgerTransaction) private readonly ledgerTransactions: Repository<LedgerTransaction>,
    @InjectRepository(LedgerAccount) private readonly ledgerAccounts: Repository<LedgerAccount>,
    @InjectRepository(OutboxEvent) private readonly events: Repository<OutboxEvent>,
    @InjectRepository(WebhookDelivery) private readonly deliveries: Repository<WebhookDelivery>,
    private readonly cancelService: PaymentCancelService,
    private readonly audit: AdminAuditService,
  ) {}

  list(filters: PaymentSearchFilters): Promise<IPageable<{ payment: Payment; order: Order }>> {
    return searchPayments({ payments: this.payments, orders: this.orders }, filters);
  }

  async detail(paymentId: string): Promise<AdminPaymentDetail> {
    const payment = await this.payments.findOne({ where: { paymentId }, relations: { cancels: { items: true } } });
    if (!payment) throw new BusinessException(ErrorCode.PAYMENT_NOT_FOUND);
    const order = await this.orders.findOneOrFail({
      where: { orderId: payment.orderId, serviceId: payment.serviceId },
      relations: { items: true },
    });

    // 원장: 결제 승인(PAYMENT) + 이 결제의 취소들(PAYMENT_CANCEL)
    const referenceIds = [payment.paymentId, ...payment.cancels.map((cancel) => cancel.paymentCancelId)];
    const ledger = await this.ledgerTransactions.find({
      where: { referenceId: In(referenceIds) },
      relations: { entries: true },
      order: { occurredAt: 'ASC', createdAt: 'ASC' },
    });
    const accountIds = [...new Set(ledger.flatMap((tx) => tx.entries.map((entry) => entry.ledgerAccountId)))];
    const accounts = accountIds.length ? await this.ledgerAccounts.findBy({ ledgerAccountId: In(accountIds) }) : [];

    const events = await this.events.find({
      where: { aggregateId: payment.paymentId },
      order: { occurredAt: 'ASC' },
    });
    const deliveries = events.length
      ? await this.deliveries.findBy({ outboxEventId: In(events.map((event) => event.outboxEventId)) })
      : [];

    return {
      payment,
      order,
      ledger,
      ledgerAccountCodes: new Map(accounts.map((account) => [account.ledgerAccountId, account.code])),
      webhookDeliveries: events.flatMap((event) =>
        deliveries
          .filter((delivery) => delivery.outboxEventId === event.outboxEventId)
          .map((delivery) => ({ delivery, event })),
      ),
    };
  }

  /**
   * 수동 환불. 서비스 환불과 같은 도메인 로직(상한·항목·멱등)에 requestedBy=ADMIN.
   * 감사 로그는 취소 요청을 기록하는 트랜잭션 안에서 — 사유가 없으면 토스를 부르기 전에 전부 롤백된다.
   */
  async cancel(paymentId: string, dto: AdminCancelPaymentRequestDto, actor: AdminActor): Promise<CancelView> {
    const payment = await this.payments.findOneBy({ paymentId });
    if (!payment) throw new BusinessException(ErrorCode.PAYMENT_NOT_FOUND);

    return this.cancelService.cancel({
      serviceId: payment.serviceId,
      paymentId,
      request: dto.toAdminRequest(),
      refundReceiveAccount: dto.refundReceiveAccount,
      onRequested: (cancel, locked) =>
        this.audit.record({
          actor,
          action: AdminAuditAction.PAYMENT_CANCELED_BY_ADMIN,
          targetType: AuditTargetType.PAYMENT,
          targetId: locked.paymentId,
          serviceId: locked.serviceId,
          before: { status: locked.status, refundedAmount: locked.refundedAmount },
          after: { paymentCancelId: cancel.paymentCancelId, amount: cancel.amount, reasonCode: cancel.reasonCode },
          reason: dto.reason,
        }),
    });
  }
}
