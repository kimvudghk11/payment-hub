import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { CreatedAtEntity } from '../../common/domain/created-at.entity';
import { LedgerAccountType } from '../constants/ledger.constants';

/** 원장 계정. (service_id, code, currency) 유니크, service_id NULL = 공통 계정(CASH 등) */
@Entity({ name: 'tb_ledger_account' })
export class LedgerAccount extends CreatedAtEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  ledgerAccountId: string;

  @Column({ name: 'service_id', type: 'uuid', nullable: true })
  serviceId: string | null;

  /** PG_RECEIVABLE, REVENUE, REFUND, PG_FEE, CASH */
  @Column({ name: 'code', type: 'varchar', length: 50 })
  code: string;

  @Column({ name: 'type', type: 'varchar', length: 20 })
  type: LedgerAccountType;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency: string;
}
