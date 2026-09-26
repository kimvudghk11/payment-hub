import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { EncryptionService } from '../common/crypto/encryption.service';
import { paginateByCreatedAt } from '../common/database/cursor-pagination';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-code';
import { IPageable } from '../common/interceptors/response.interceptor';
import { LedgerService } from '../ledger/ledger.service';
import { OrderItem } from '../order/domain/order-item.entity';
import { Order } from '../order/domain/order.entity';
import { OutboxEventType } from '../outbox/constants/outbox.constants';
import { OutboxService } from '../outbox/outbox.service';
import { PgProvider } from '../pg/constants/pg.constants';
import { hubErrorForTossRejection } from '../pg/toss-error';
import { TossPaymentsClient, TossResult } from '../pg/toss-payments.client';
import { ServiceService } from '../service/service.service';
import { PaymentStatus } from './constants/payment.constants';
import { Payment } from './domain/payment.entity';
import { ListPaymentsQueryDto } from './dto/request/list-payments.query.dto';

export interface ConfirmPaymentCommand {
  serviceId: string;
  orderId: string;
  paymentKey: string;
  amount: number;
}

/** 결제 + 서비스가 자기 주문과 연결하는 데 필요한 주문 정보 */
export interface PaymentView {
  payment: Payment;
  order: Order;
}

/** 결과가 확정되지 않아 살아있는 것으로 보는 상태 (한 주문에 하나만 — uq_tb_payment_one_live_per_order) */
const DEAD_STATUSES = [PaymentStatus.FAILED, PaymentStatus.ABORTED, PaymentStatus.EXPIRED];
const PENDING_RESULT_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.IN_PROGRESS,
  PaymentStatus.UNKNOWN,
  PaymentStatus.WAITING_FOR_DEPOSIT,
]);

/**
 * 결제 유스케이스. 토스 호출은 DB 트랜잭션 밖에서 한다.
 *   (tx1) 주문 락 → 검증 → 결제 IN_PROGRESS 선기록 → 토스 호출 → (tx2) 결과 반영 + 원장 + outbox
 * 모든 조회·쓰기는 인증된 serviceId로 범위를 고정한다.
 */
@Injectable()
export class PaymentService {
  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(OrderItem) private readonly orderItems: Repository<OrderItem>,
    private readonly serviceService: ServiceService,
    private readonly encryption: EncryptionService,
    private readonly toss: TossPaymentsClient,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * 결제 승인. 같은 paymentKey 재요청은 토스를 다시 부르지 않고 기록된 결과를 준다.
   * 결과를 모르면(타임아웃 등) 결제를 UNKNOWN으로 남기고 PG_TIMEOUT/PG_ERROR — 대사가 확정한다.
   */
  async confirm(command: ConfirmPaymentCommand): Promise<PaymentView> {
    // 자격증명이 없으면 결제를 기록하기 전에 실패시킨다
    const credential = await this.serviceService.getActivePgCredential(command.serviceId);
    const secretKey = this.encryption.decrypt(credential.secretKeyEnc, credential.secretKeyId);

    const started = await this.startConfirm(command, new Date());
    if (started.replayed) return this.replay(started.view);

    const { payment } = started.view;
    const result = await this.toss.confirm({
      secretKey,
      paymentKey: command.paymentKey,
      orderId: payment.orderId,
      amount: payment.amount,
      idempotencyKey: payment.idempotencyKey,
    });
    const view = await this.applyConfirmResult(payment.paymentId, result);
    return this.settle(view, result);
  }

  async get(serviceId: string, paymentId: string): Promise<PaymentView> {
    const payment = await this.payments.findOneBy({ paymentId, serviceId });
    if (!payment) throw new BusinessException(ErrorCode.PAYMENT_NOT_FOUND);
    return { payment, order: await this.orders.findOneByOrFail({ orderId: payment.orderId, serviceId }) };
  }

  /** 결제 목록 (서비스 + 사용자 단위 이력 등). 주문의 외부 ID로 거르기 위해 주문과 조인한다 */
  async list(serviceId: string, query: ListPaymentsQueryDto): Promise<IPageable<PaymentView>> {
    const filtered = this.payments
      .createQueryBuilder('p')
      .innerJoin(Order, 'o', 'o.orderId = p.orderId AND o.serviceId = p.serviceId')
      .where('p.serviceId = :serviceId', { serviceId });
    if (query.externalUserId) filtered.andWhere('o.externalUserId = :eu', { eu: query.externalUserId });
    if (query.externalOrderId) filtered.andWhere('o.externalOrderId = :eo', { eo: query.externalOrderId });
    if (query.externalSubscriptionId) {
      filtered.andWhere('o.externalSubscriptionId = :es', { es: query.externalSubscriptionId });
    }
    if (query.status?.length) filtered.andWhere('p.status IN (:...statuses)', { statuses: query.status });
    if (query.methodType) filtered.andWhere('p.methodType = :methodType', { methodType: query.methodType });
    if (query.from) filtered.andWhere('p.createdAt >= :from', { from: new Date(query.from) });
    if (query.to) filtered.andWhere('p.createdAt < :to', { to: new Date(query.to) });

    const page = await paginateByCreatedAt(filtered, {
      alias: 'p',
      idProperty: 'paymentId',
      limit: query.limit,
      cursor: query.cursor,
    });
    const orderIds = [...new Set(page.data.map((payment) => payment.orderId))];
    const orders = new Map(
      (await this.orders.findBy({ serviceId, orderId: In(orderIds) })).map((order) => [order.orderId, order]),
    );
    return {
      ...page,
      data: page.data.map((payment) => ({ payment, order: orders.get(payment.orderId) as Order })),
    };
  }

  /** 환불 가능 금액과 항목별 취소 수량 계산에 필요한 결제·주문 항목 */
  async getRefundable(serviceId: string, paymentId: string): Promise<{ payment: Payment; items: OrderItem[] }> {
    const { payment } = await this.get(serviceId, paymentId);
    const items = await this.orderItems.findBy({ orderId: payment.orderId, serviceId });
    return { payment, items };
  }

  /**
   * (tx1) 주문 행 락으로 같은 주문의 승인 요청을 직렬화한다.
   * 락 안에서 paymentKey 재요청 여부와 살아있는 결제를 확인하므로 동시 요청이 와도 토스 승인은 한 번이다.
   */
  @Transactional()
  private async startConfirm(
    command: ConfirmPaymentCommand,
    now: Date,
  ): Promise<{ view: PaymentView; replayed: boolean }> {
    const order = await this.orders.findOne({
      where: { orderId: command.orderId, serviceId: command.serviceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!order) throw new BusinessException(ErrorCode.ORDER_NOT_FOUND);

    const previous = await this.payments.findOneBy({
      serviceId: command.serviceId,
      provider: PgProvider.TOSS,
      providerPaymentKey: command.paymentKey,
    });
    if (previous) {
      if (previous.orderId !== order.orderId) {
        throw new BusinessException(ErrorCode.INVALID_REQUEST, {
          errors: [{ field: 'paymentKey', message: '다른 주문의 paymentKey입니다.' }],
        });
      }
      if (previous.amount !== command.amount) throw new BusinessException(ErrorCode.PAYMENT_AMOUNT_MISMATCH);
      return { view: { payment: previous, order }, replayed: true };
    }

    const live = await this.payments.findOneBy({ orderId: order.orderId, status: Not(In(DEAD_STATUSES)) });
    if (live) {
      throw PENDING_RESULT_STATUSES.has(live.status)
        ? new BusinessException(ErrorCode.PAYMENT_IN_PROGRESS, { paymentId: live.paymentId })
        : new BusinessException(ErrorCode.ORDER_ALREADY_PAID);
    }

    order.assertConfirmable(command.amount, now);
    const payment = Payment.startConfirm({ order, paymentKey: command.paymentKey });
    await this.payments.save(payment);
    return { view: { payment, order }, replayed: false };
  }

  /**
   * (tx2) 토스 결과 반영. 결제 상태·주문 상태·원장·outbox를 한 트랜잭션으로 묶는다.
   * 그 사이 대사가 먼저 확정했으면(IN_PROGRESS가 아니면) 덮어쓰지 않는다.
   */
  @Transactional()
  private async applyConfirmResult(paymentId: string, result: TossResult): Promise<PaymentView> {
    const payment = await this.payments.findOneOrFail({ where: { paymentId }, lock: { mode: 'pessimistic_write' } });
    const order = await this.orders.findOneOrFail({
      where: { orderId: payment.orderId, serviceId: payment.serviceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (payment.status !== PaymentStatus.IN_PROGRESS) return { payment, order };

    if (result.outcome === 'APPROVED') payment.applyTossPayment(result.payment);
    else if (result.outcome === 'REJECTED') payment.markFailed(result);
    else payment.markUnknown(result.response);
    await this.payments.save(payment);
    await this.recordOutcome(payment, order);
    return { payment, order };
  }

  /** 결제 상태가 정해진 뒤의 후속 기록 (호출한 트랜잭션 안에서). UNKNOWN은 대사가 확정할 때 기록한다 */
  private async recordOutcome(payment: Payment, order: Order): Promise<void> {
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

  /** 트랜잭션이 커밋된 뒤 응답을 정한다 (실패 응답이 결과 반영을 롤백하지 않도록 tx2 밖에서 던진다) */
  private settle(view: PaymentView, result: TossResult): PaymentView {
    if (view.payment.status === PaymentStatus.UNKNOWN) {
      const timedOut =
        result.outcome === 'UNKNOWN' && (result.reason === 'TIMEOUT' || result.reason === 'NETWORK_ERROR');
      throw new BusinessException(timedOut ? ErrorCode.PG_TIMEOUT : ErrorCode.PG_ERROR, {
        paymentId: view.payment.paymentId,
        paymentStatus: view.payment.status,
      });
    }
    return this.replay(view);
  }

  /** 기록된 결제 상태 그대로 응답: 확정 성공은 결과, 처리 중은 409, 실패는 저장된 토스 사유 */
  private replay(view: PaymentView): PaymentView {
    const { payment } = view;
    if (payment.status === PaymentStatus.IN_PROGRESS || payment.status === PaymentStatus.UNKNOWN) {
      throw new BusinessException(ErrorCode.PAYMENT_IN_PROGRESS, { paymentId: payment.paymentId });
    }
    if (payment.status === PaymentStatus.FAILED || payment.status === PaymentStatus.ABORTED) {
      const pgCode = payment.failureCode ?? 'UNKNOWN';
      throw new BusinessException(hubErrorForTossRejection(pgCode), {
        paymentId: payment.paymentId,
        paymentStatus: payment.status,
        pgCode,
        pgMessage: payment.failureMessage,
      });
    }
    return view;
  }
}
