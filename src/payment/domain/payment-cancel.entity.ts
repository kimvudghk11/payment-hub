import { randomUUID } from 'crypto';
import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import { bigintAmountTransformer } from '../../common/database/bigint-amount.transformer';
import { CancelRequestedBy, PaymentCancelStatus } from '../constants/payment.constants';
import { PaymentCancelItem } from './payment-cancel-item.entity';
import type { Payment } from './payment.entity';

/** 취소(환불) 요청 1건. 토스 호출 전에 REQUESTED로 먼저 저장한다. */
@Entity({ name: 'tb_payment_cancel' })
export class PaymentCancel extends BaseEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  paymentCancelId: string;

  @Column({ name: 'payment_id', type: 'uuid' })
  paymentId: string;

  @Column({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  /** 서비스가 보낸 값. (service_id, idempotency_key) 재요청 시 같은 결과 반환 */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 100 })
  idempotencyKey: string;

  @Column({ name: 'amount', type: 'bigint', transformer: bigintAmountTransformer })
  amount: number;

  /** 서비스 정의 값. 저장만 */
  @Column({ name: 'reason_code', type: 'varchar', length: 50 })
  reasonCode: string;

  /** 토스 cancelReason으로 전달 */
  @Column({ name: 'reason_detail', type: 'varchar', length: 200, nullable: true })
  reasonDetail: string | null;

  @Column({ name: 'requested_by', type: 'varchar', length: 20 })
  requestedBy: CancelRequestedBy;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status: PaymentCancelStatus;

  /** 토스 cancels[].transactionKey */
  @Column({ name: 'provider_transaction_key', type: 'varchar', length: 200, nullable: true })
  providerTransactionKey: string | null;

  @Column({ name: 'failure_code', type: 'varchar', length: 100, nullable: true })
  failureCode: string | null;

  @Column({ name: 'failure_message', type: 'text', nullable: true })
  failureMessage: string | null;

  @Column({ name: 'canceled_at', type: 'timestamptz', nullable: true })
  canceledAt: Date | null;

  @ManyToOne('Payment', (payment: Payment) => payment.cancels)
  @JoinColumn([
    { name: 'payment_id', referencedColumnName: 'paymentId' },
    { name: 'service_id', referencedColumnName: 'serviceId' },
  ])
  payment: Payment;

  @OneToMany(() => PaymentCancelItem, (item) => item.cancel)
  items: PaymentCancelItem[];

  /** Payment.requestCancel에서만 만든다 (검증은 결제가 한다). 항목이 같은 ID를 참조하도록 ID를 여기서 정한다 */
  static request(params: {
    paymentId: string;
    serviceId: string;
    idempotencyKey: string;
    amount: number;
    reasonCode: string;
    reasonDetail: string | null;
    requestedBy: CancelRequestedBy;
    items: { orderItemId: string; quantity: number; amount: number }[];
  }): PaymentCancel {
    const cancel = new PaymentCancel();
    cancel.paymentCancelId = randomUUID();
    cancel.paymentId = params.paymentId;
    cancel.serviceId = params.serviceId;
    cancel.idempotencyKey = params.idempotencyKey;
    cancel.amount = params.amount;
    cancel.reasonCode = params.reasonCode;
    cancel.reasonDetail = params.reasonDetail;
    cancel.requestedBy = params.requestedBy;
    cancel.status = PaymentCancelStatus.REQUESTED;
    cancel.providerTransactionKey = null;
    cancel.failureCode = null;
    cancel.failureMessage = null;
    cancel.canceledAt = null;
    cancel.items = params.items.map((item) => PaymentCancelItem.create(cancel.paymentCancelId, item));
    return cancel;
  }

  /** 결과를 아직 모르는 취소 — 환불 가능 금액에서 미리 빼 둔다 */
  get isPending(): boolean {
    return this.status === PaymentCancelStatus.REQUESTED || this.status === PaymentCancelStatus.UNKNOWN;
  }

  markDone(result: { transactionKey: string | null; canceledAt: Date }): void {
    this.assertPending();
    this.status = PaymentCancelStatus.DONE;
    this.providerTransactionKey = result.transactionKey;
    this.canceledAt = result.canceledAt;
  }

  markFailed(failure: { code: string; message: string }): void {
    this.assertPending();
    this.status = PaymentCancelStatus.FAILED;
    this.failureCode = failure.code;
    this.failureMessage = failure.message;
  }

  markUnknown(): void {
    this.assertPending();
    this.status = PaymentCancelStatus.UNKNOWN;
  }

  private assertPending(): void {
    if (!this.isPending) throw new Error(`취소 ${this.paymentCancelId}: ${this.status} 상태는 결과를 바꿀 수 없음`);
  }
}
