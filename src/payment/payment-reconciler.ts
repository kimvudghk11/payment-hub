import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { EncryptionService } from '../common/crypto/encryption.service';
import { BusinessException } from '../common/errors/business.exception';
import { Order } from '../order/domain/order.entity';
import { TossPayment } from '../pg/toss-payment.types';
import { TossPaymentsClient, TossResult } from '../pg/toss-payments.client';
import { ServiceService } from '../service/service.service';
import { PaymentCancelStatus, PaymentStatus } from './constants/payment.constants';
import { PaymentCancel } from './domain/payment-cancel.entity';
import { Payment } from './domain/payment.entity';
import { PaymentCancelService } from './payment-cancel.service';
import { PaymentOutcomeService } from './payment-outcome.service';

/**
 * 이 시간이 지난 결과 불명 결제만 대사한다. 토스 승인 타임아웃(TOSS_API_TIMEOUT_MS, 기본 30초)보다 충분히 길어야
 * 아직 진행 중인 승인 요청과 겹치지 않는다.
 */
export const RECONCILE_MIN_AGE_MS = 2 * 60_000;
export const RECONCILE_BATCH_SIZE = 20;

const UNRESOLVED_STATUSES: PaymentStatus[] = [PaymentStatus.IN_PROGRESS, PaymentStatus.UNKNOWN];

export interface ReconcileResult {
  checked: number;
  resolved: number;
}

/**
 * 대사: IN_PROGRESS(선기록 후 멈춤)·UNKNOWN(결과 불명) 결제를 토스 조회로 확정한다.
 * 토스 조회는 트랜잭션 밖, 반영은 결제 행 락 후 같은 규칙(PaymentOutcomeService)으로. 여러 인스턴스가 같은 결제를
 * 동시에 조회해도 반영은 락 + 상태 확인으로 한 번만 된다.
 * 확정하지 못한 결제는 updated_at만 갱신해 다음 대사 순서의 뒤로 보낸다 (오래 안 풀리는 건이 다른 건을 막지 않게).
 */
@Injectable()
export class PaymentReconciler {
  private readonly logger = new Logger(PaymentReconciler.name);

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly serviceService: ServiceService,
    private readonly encryption: EncryptionService,
    private readonly toss: TossPaymentsClient,
    private readonly outcome: PaymentOutcomeService,
    @InjectRepository(PaymentCancel) private readonly cancels: Repository<PaymentCancel>,
    private readonly cancelService: PaymentCancelService,
  ) {}

  async reconcileDue(now: Date = new Date(), limit: number = RECONCILE_BATCH_SIZE): Promise<ReconcileResult> {
    const candidates = await this.payments.find({
      where: {
        status: In(UNRESOLVED_STATUSES),
        updatedAt: LessThanOrEqual(new Date(now.getTime() - RECONCILE_MIN_AGE_MS)),
      },
      order: { updatedAt: 'ASC' },
      take: limit,
    });

    let resolved = 0;
    for (const candidate of candidates) {
      const result = await this.lookup(candidate);
      if ((await this.apply(candidate.paymentId, result)).resolved) resolved += 1;
    }
    return { checked: candidates.length, resolved };
  }

  /** 환불 대사: 2분 이상 지난 REQUESTED·UNKNOWN 취소를 같은 멱등키로 토스에 다시 확인 (PaymentCancelService.resolvePending) */
  async reconcileCancelsDue(now: Date = new Date(), limit: number = RECONCILE_BATCH_SIZE): Promise<ReconcileResult> {
    const candidates = await this.cancels.find({
      select: { paymentCancelId: true },
      where: {
        status: In([PaymentCancelStatus.REQUESTED, PaymentCancelStatus.UNKNOWN]),
        updatedAt: LessThanOrEqual(new Date(now.getTime() - RECONCILE_MIN_AGE_MS)),
      },
      order: { updatedAt: 'ASC' },
      take: limit,
    });
    let resolved = 0;
    for (const { paymentCancelId } of candidates) {
      if (await this.cancelService.resolvePending(paymentCancelId)) resolved += 1;
    }
    return { checked: candidates.length, resolved };
  }

  /**
   * 결제 한 건을 지금 대사한다 (관리자 수동 대사). 경과 시간 조건 없이 토스를 조회한다.
   * 이미 확정된 결제는 토스를 부르지 않는다. onResolved는 확정한 트랜잭션 안에서 실행된다 (감사 로그용).
   */
  async reconcileOne(
    paymentId: string,
    onResolved?: (before: { status: PaymentStatus }, payment: Payment) => Promise<void>,
  ): Promise<{ resolved: boolean; payment: Payment }> {
    const payment = await this.payments.findOneByOrFail({ paymentId });
    if (!UNRESOLVED_STATUSES.includes(payment.status)) return { resolved: false, payment };
    return this.apply(paymentId, await this.lookup(payment), onResolved);
  }

  private async lookup(payment: Payment): Promise<TossResult | null> {
    if (!payment.providerPaymentKey) return null;
    try {
      const credential = await this.serviceService.getActivePgCredential(payment.serviceId);
      return await this.toss.getPayment({
        secretKey: this.encryption.decrypt(credential.secretKeyEnc, credential.secretKeyId),
        paymentKey: payment.providerPaymentKey,
      });
    } catch (error) {
      if (error instanceof BusinessException) return null; // 활성 토스 키 없음 — 운영자가 키를 등록하면 다음 대사에서 확정
      throw error;
    }
  }

  /** @returns resolved: 결제를 확정했으면 true */
  @Transactional()
  private async apply(
    paymentId: string,
    result: TossResult | null,
    onResolved?: (before: { status: PaymentStatus }, payment: Payment) => Promise<void>,
  ): Promise<{ resolved: boolean; payment: Payment }> {
    const payment = await this.payments.findOneOrFail({ where: { paymentId }, lock: { mode: 'pessimistic_write' } });
    if (!UNRESOLVED_STATUSES.includes(payment.status)) return { resolved: false, payment }; // 그 사이 승인 응답·다른 대사가 확정함
    const before = { status: payment.status };

    if (result?.outcome === 'APPROVED' && this.belongsTo(result.payment, payment)) {
      const order = await this.orders.findOneOrFail({
        where: { orderId: payment.orderId, serviceId: payment.serviceId },
        lock: { mode: 'pessimistic_write' },
      });
      payment.applyTossPayment(result.payment);
      await this.payments.save(payment);
      await this.outcome.record(payment, order);
      if (payment.status !== PaymentStatus.UNKNOWN) {
        await onResolved?.(before, payment);
        return { resolved: true, payment };
      }
    }

    // 확정 못 함: 대사 순서의 뒤로
    await this.payments.update({ paymentId }, { updatedAt: new Date() });
    return { resolved: false, payment };
  }

  /** 토스 응답이 정말 이 결제의 것인지. 다르면 믿지 않고 UNKNOWN으로 남겨 사람이 본다 */
  private belongsTo(response: TossPayment, payment: Payment): boolean {
    const matches =
      response.paymentKey === payment.providerPaymentKey &&
      response.orderId === payment.orderId &&
      response.totalAmount === payment.amount;
    if (!matches && ['DONE', 'WAITING_FOR_DEPOSIT'].includes(response.status)) {
      this.logger.error(`결제 ${payment.paymentId}: 토스 조회 결과가 결제 기록과 다릅니다 (수동 확인 필요)`);
    }
    return matches;
  }
}
