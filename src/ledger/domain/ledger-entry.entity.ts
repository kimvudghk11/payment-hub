import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { CreatedAtEntity } from '../../common/domain/created-at.entity';
import { bigintAmountTransformer } from '../../common/database/bigint-amount.transformer';
import { LedgerDirection } from '../constants/ledger.constants';
import type { LedgerTransaction } from './ledger-transaction.entity';

/** 분개 한 줄. 트랜잭션별 차변 합 = 대변 합을 커밋 시점 트리거가 강제한다. */
@Entity({ name: 'tb_ledger_entry' })
export class LedgerEntry extends CreatedAtEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  ledgerEntryId: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  ledgerTransactionId: string;

  @Column({ name: 'account_id', type: 'uuid' })
  ledgerAccountId: string;

  @Column({ name: 'direction', type: 'varchar', length: 6 })
  direction: LedgerDirection;

  @Column({ name: 'amount', type: 'bigint', transformer: bigintAmountTransformer })
  amount: number;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency: string;

  @ManyToOne('LedgerTransaction', (transaction: LedgerTransaction) => transaction.entries)
  @JoinColumn({ name: 'transaction_id', referencedColumnName: 'ledgerTransactionId' })
  transaction: LedgerTransaction;
}
