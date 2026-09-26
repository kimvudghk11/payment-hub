import { randomUUID } from 'crypto';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { CreatedAtEntity } from '../../common/domain/created-at.entity';
import { PaymentStatus } from '../../payment/constants/payment.constants';
import type { Payment } from '../../payment/domain/payment.entity';
import { LedgerDirection, LedgerReferenceType, LedgerTransactionType } from '../constants/ledger.constants';
import { LedgerEntry } from './ledger-entry.entity';

/**
 * 분개 묶음. append-only (UPDATE/DELETE는 DB 트리거가 차단).
 * (transaction_type, reference_type, reference_id) 유니크 → 같은 사건 이중 기장 불가.
 */
@Entity({ name: 'tb_ledger_transaction' })
export class LedgerTransaction extends CreatedAtEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  ledgerTransactionId: string;

  @Column({ name: 'service_id', type: 'uuid', nullable: true })
  serviceId: string | null;

  @Column({ name: 'transaction_type', type: 'varchar', length: 30 })
  transactionType: LedgerTransactionType;

  /** PAYMENT / PAYMENT_CANCEL / SETTLEMENT */
  @Column({ name: 'reference_type', type: 'varchar', length: 30 })
  referenceType: string;

  @Column({ name: 'reference_id', type: 'uuid' })
  referenceId: string;

  @Column({ name: 'description', type: 'varchar', length: 200, nullable: true })
  description: string | null;

  /** 사건 발생 시각 (토스 approvedAt 등) */
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @OneToMany(() => LedgerEntry, (entry) => entry.transaction)
  entries: LedgerEntry[];

  /** 결제 승인: 차) PG 미수금 / 대) 매출. 사건 시각은 토스 승인 시각 */
  static paymentCaptured(
    payment: Payment,
    accounts: { pgReceivableAccountId: string; revenueAccountId: string },
  ): LedgerTransaction {
    if (payment.status !== PaymentStatus.DONE || !payment.approvedAt) {
      throw new Error(`결제 ${payment.paymentId}: ${payment.status} 상태는 매출 기장 대상이 아님`);
    }
    const transaction = new LedgerTransaction();
    transaction.ledgerTransactionId = randomUUID();
    transaction.serviceId = payment.serviceId;
    transaction.transactionType = LedgerTransactionType.PAYMENT_CAPTURED;
    transaction.referenceType = LedgerReferenceType.PAYMENT;
    transaction.referenceId = payment.paymentId;
    transaction.description = null;
    transaction.occurredAt = payment.approvedAt;
    transaction.entries = [
      LedgerEntry.create(transaction, accounts.pgReceivableAccountId, LedgerDirection.DEBIT, payment),
      LedgerEntry.create(transaction, accounts.revenueAccountId, LedgerDirection.CREDIT, payment),
    ];
    return transaction;
  }
}
