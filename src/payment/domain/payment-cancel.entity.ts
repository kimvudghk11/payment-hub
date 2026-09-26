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
}
