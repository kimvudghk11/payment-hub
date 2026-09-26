import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { EncryptionService } from '../common/crypto/encryption.service';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-code';
import { LedgerService } from '../ledger/ledger.service';
import { OrderItem } from '../order/domain/order-item.entity';
import { Order } from '../order/domain/order.entity';
import { OutboxService } from '../outbox/outbox.service';
import { hubErrorForTossRejection } from '../pg/toss-error';
import { TossPaymentsClient, TossResult } from '../pg/toss-payments.client';
import { ServiceService } from '../service/service.service';
import { PaymentCancelStatus, PaymentMethodType } from './constants/payment.constants';
import { PaymentCancelItem } from './domain/payment-cancel-item.entity';
import { PaymentCancel } from './domain/payment-cancel.entity';
import { CancelRequest, Payment } from './domain/payment.entity';

export interface CancelPaymentCommand {
  serviceId: string;
  paymentId: string;
  request: CancelRequest;
  /** 가상계좌 환불 계좌. 토스에 전달만 하고 저장하지 않는다 */
  refundReceiveAccount?: { bankCode: string; accountNumber: string; holderName: string };
  /**
   * 취소 요청을 기록한 트랜잭션(tx1) 안에서 실행 — 토스 호출 전. admin 수동 환불의 감사 로그용.
   * 여기서 던지면(예: 사유 누락) 취소 기록도 롤백되고 토스를 부르지 않는다. 멱등 재요청에는 호출되지 않는다.
   */
  onRequested?: (cancel: PaymentCancel, payment: Payment) => Promise<void>;
}

export interface CancelView {
  cancel: PaymentCancel;
  payment: Payment;
  order: Order;
}

/**
 * 환불 유스케이스. 결제와 같은 순서: (tx1) 결제 행 락 → 검증 → 취소 REQUESTED 선기록 → 토스 취소(트랜잭션 밖)
 * → (tx2) 결과 반영 + 결제·주문·항목 + 원장 반대 분개 + outbox. 에러는 tx2 커밋 뒤에 던진다.
 */
@Injectable()
export class PaymentCancelService {
  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(PaymentCancel) private readonly cancels: Repository<PaymentCancel>,
    @InjectRepository(PaymentCancelItem) private readonly cancelItems: Repository<PaymentCancelItem>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(OrderItem) private readonly orderItems: Repository<OrderItem>,
    private readonly serviceService: ServiceService,
    private readonly encryption: EncryptionService,
    private readonly toss: TossPaymentsClient,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
  ) {}

  async cancel(command: CancelPaymentCommand): Promise<CancelView> {
    const credential = await this.serviceService.getActivePgCredential(command.serviceId);
    const secretKey = this.encryption.decrypt(credential.secretKeyEnc, credential.secretKeyId);

    const started = await this.startCancel(command);
    if (started.replayed) return this.replay(started.view);

    const { cancel, payment } = started.view;
    const result = await this.callToss(secretKey, payment, cancel, command.refundReceiveAccount);
    const view = await this.applyCancelResult(cancel.paymentCancelId, result);
    return this.settle(view, result);
  }

  /**
   * 대사: 결과 불명(UNKNOWN)·멈춘(REQUESTED) 취소를 **같은 멱등키**로 토스에 다시 보낸다.
   * 토스는 같은 키면 처음 결과를 돌려주고, 처음 요청이 도달하지 않았으면 지금 처리한다 — 어느 쪽이든 요청된 환불이 한 번 반영된다.
   * 가상계좌 환불 계좌는 저장하지 않으므로, 토스에 도달하지 못한 가상계좌 환불은 거절(FAILED)되고 금액이 풀린다.
   * @returns 확정했으면 true. 여전히 모르면 updated_at만 갱신해 대사 순서의 뒤로
   */
  async resolvePending(paymentCancelId: string): Promise<boolean> {
    const cancel = await this.cancels.findOneBy({ paymentCancelId });
    if (!cancel?.isPending) return false;
    const payment = await this.payments.findOneByOrFail({ paymentId: cancel.paymentId });

    let result: TossResult | null = null;
    try {
      const credential = await this.serviceService.getActivePgCredential(payment.serviceId);
      const secretKey = this.encryption.decrypt(credential.secretKeyEnc, credential.secretKeyId);
      result = await this.callToss(secretKey, payment, cancel);
    } catch (error) {
      if (!(error instanceof BusinessException)) throw error; // 활성 토스 키 없음 — 다음 대사에서
    }

    if (result) {
      const view = await this.applyCancelResult(paymentCancelId, result);
      if (!view.cancel.isPending) return true;
    }
    await this.cancels.update({ paymentCancelId }, { updatedAt: new Date() });
    return false;
  }

  private callToss(
    secretKey: string,
    payment: Payment,
    cancel: PaymentCancel,
    refundReceiveAccount?: CancelPaymentCommand['refundReceiveAccount'],
  ): Promise<TossResult> {
    return this.toss.cancel({
      secretKey,
      paymentKey: payment.providerPaymentKey ?? '',
      cancelReason: cancel.reasonDetail ?? cancel.reasonCode,
      cancelAmount: cancel.amount,
      // 취소 건마다 고정 — 같은 취소를 다시 호출해도(재요청·대사) 토스가 한 번만 처리한다
      idempotencyKey: `cancel:${cancel.paymentCancelId}`,
      refundReceiveAccount,
    });
  }

  /**
   * (tx1) 결제 행 락 안에서 멱등 재요청 확인과 상한 검증을 한다.
   * 처리 중 취소까지 로드한 상태로 Payment.requestCancel을 호출해야 동시 부분 환불이 상한을 넘지 않는다.
   */
  @Transactional()
  private async startCancel(command: CancelPaymentCommand): Promise<{ view: CancelView; replayed: boolean }> {
    const payment = await this.payments.findOne({
      where: { paymentId: command.paymentId, serviceId: command.serviceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment) throw new BusinessException(ErrorCode.PAYMENT_NOT_FOUND);
    const order = await this.orders.findOneByOrFail({ orderId: payment.orderId, serviceId: payment.serviceId });

    const previous = await this.cancels.findOne({
      where: { serviceId: command.serviceId, idempotencyKey: command.request.idempotencyKey },
      relations: { items: true },
    });
    if (previous) {
      if (!previous.matches(payment.paymentId, command.request)) {
        throw new BusinessException(ErrorCode.CANCEL_IDEMPOTENCY_CONFLICT);
      }
      return { view: { cancel: previous, payment, order }, replayed: true };
    }

    if (payment.methodType === PaymentMethodType.VIRTUAL_ACCOUNT && !command.refundReceiveAccount) {
      throw new BusinessException(ErrorCode.INVALID_REQUEST, {
        errors: [{ field: 'refundReceiveAccount', message: '가상계좌 결제는 환불 계좌가 필요합니다.' }],
      });
    }

    payment.cancels = await this.cancels.find({ where: { paymentId: payment.paymentId }, relations: { items: true } });
    const orderItems = await this.orderItems.findBy({ orderId: payment.orderId, serviceId: payment.serviceId });
    const cancel = payment.requestCancel(command.request, orderItems);
    await this.cancels.save(cancel);
    if (cancel.items.length > 0) await this.cancelItems.save(cancel.items);
    await command.onRequested?.(cancel, payment);
    return { view: { cancel, payment, order }, replayed: false };
  }

  /** (tx2) 토스 결과 반영. 이미 결과가 정해진 취소는 덮어쓰지 않는다 */
  @Transactional()
  private async applyCancelResult(paymentCancelId: string, result: TossResult): Promise<CancelView> {
    const cancel = await this.cancels.findOneOrFail({
      where: { paymentCancelId },
      lock: { mode: 'pessimistic_write' },
    });
    cancel.items = await this.cancelItems.findBy({ paymentCancelId });
    const payment = await this.payments.findOneOrFail({
      where: { paymentId: cancel.paymentId },
      lock: { mode: 'pessimistic_write' },
    });
    const order = await this.orders.findOneOrFail({
      where: { orderId: payment.orderId, serviceId: payment.serviceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!cancel.isPending) return { cancel, payment, order };

    if (result.outcome === 'APPROVED') {
      const tossCancel = result.payment.cancels?.at(-1);
      cancel.markDone({
        transactionKey: tossCancel?.transactionKey ?? null,
        canceledAt: tossCancel?.canceledAt ? new Date(tossCancel.canceledAt) : new Date(),
      });
      await this.cancels.save(cancel);

      payment.applyCanceled(cancel);
      await this.payments.save(payment);

      order.items = await this.orderItems.findBy({ orderId: order.orderId, serviceId: order.serviceId });
      order.applyRefund(payment, cancel.items);
      await this.orders.save(order);
      await this.orderItems.save(order.items);

      await this.ledger.recordPaymentCanceled(cancel, payment.currency);
      await this.outbox.publishPaymentCancelEvent(payment, order, cancel);
    } else if (result.outcome === 'REJECTED') {
      cancel.markFailed(result);
      await this.cancels.save(cancel);
    } else {
      cancel.markUnknown();
      await this.cancels.save(cancel);
    }
    return { cancel, payment, order };
  }

  /** 트랜잭션 커밋 뒤 응답 결정. 결과 불명이면 PG_TIMEOUT/PG_ERROR */
  private settle(view: CancelView, result: TossResult): CancelView {
    if (view.cancel.status === PaymentCancelStatus.UNKNOWN) {
      const timedOut =
        result.outcome === 'UNKNOWN' && (result.reason === 'TIMEOUT' || result.reason === 'NETWORK_ERROR');
      throw new BusinessException(timedOut ? ErrorCode.PG_TIMEOUT : ErrorCode.PG_ERROR, {
        paymentCancelId: view.cancel.paymentCancelId,
        cancelStatus: view.cancel.status,
      });
    }
    return this.replay(view);
  }

  /** 기록된 취소 상태 그대로: DONE은 결과, 처리 중은 409, 실패는 저장된 토스 사유 */
  private replay(view: CancelView): CancelView {
    const { cancel } = view;
    if (cancel.isPending) {
      throw new BusinessException(ErrorCode.CANCEL_IN_PROGRESS, { paymentCancelId: cancel.paymentCancelId });
    }
    if (cancel.status === PaymentCancelStatus.FAILED) {
      const pgCode = cancel.failureCode ?? cancel.status;
      throw new BusinessException(hubErrorForTossRejection(pgCode, ErrorCode.CANCEL_REJECTED), {
        paymentCancelId: cancel.paymentCancelId,
        cancelStatus: cancel.status,
        pgCode,
        pgMessage: cancel.failureMessage,
      });
    }
    return view;
  }
}
