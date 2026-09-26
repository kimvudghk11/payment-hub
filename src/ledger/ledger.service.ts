import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaymentCancel } from '../payment/domain/payment-cancel.entity';
import { Payment } from '../payment/domain/payment.entity';
import { LEDGER_ACCOUNT_TYPES, LedgerAccountCode } from './constants/ledger.constants';
import { LedgerAccount } from './domain/ledger-account.entity';
import { LedgerEntry } from './domain/ledger-entry.entity';
import { LedgerTransaction } from './domain/ledger-transaction.entity';

/**
 * 원장 기장. 결제·취소 상태 변경과 같은 트랜잭션 안에서 호출한다 (호출하는 쪽의 @Transactional에 참여).
 * append-only — 이 서비스는 INSERT만 한다.
 */
@Injectable()
export class LedgerService {
  constructor(
    @InjectRepository(LedgerAccount) private readonly accounts: Repository<LedgerAccount>,
    @InjectRepository(LedgerTransaction) private readonly transactions: Repository<LedgerTransaction>,
    @InjectRepository(LedgerEntry) private readonly entries: Repository<LedgerEntry>,
  ) {}

  /** 결제 승인: 차) PG 미수금 / 대) 매출 */
  async recordPaymentCaptured(payment: Payment): Promise<LedgerTransaction> {
    const transaction = LedgerTransaction.paymentCaptured(payment, {
      pgReceivableAccountId: await this.accountId(payment.serviceId, LedgerAccountCode.PG_RECEIVABLE, payment.currency),
      revenueAccountId: await this.accountId(payment.serviceId, LedgerAccountCode.REVENUE, payment.currency),
    });
    await this.transactions.insert(transaction);
    await this.entries.insert(transaction.entries);
    return transaction;
  }

  /** 환불(취소 확정 건): 차) 환불 / 대) PG 미수금 */
  async recordPaymentCanceled(cancel: PaymentCancel, currency: string): Promise<LedgerTransaction> {
    const transaction = LedgerTransaction.paymentCanceled(cancel, currency, {
      refundAccountId: await this.accountId(cancel.serviceId, LedgerAccountCode.REFUND, currency),
      pgReceivableAccountId: await this.accountId(cancel.serviceId, LedgerAccountCode.PG_RECEIVABLE, currency),
    });
    await this.transactions.insert(transaction);
    await this.entries.insert(transaction.entries);
    return transaction;
  }

  /**
   * 서비스·계정 코드·통화별 계정. 서비스 등록 시 미리 만들지 않고 첫 기장 때 만든다.
   * 동시에 만들어도 유니크 제약 + ON CONFLICT DO NOTHING으로 하나만 남는다.
   */
  private async accountId(serviceId: string, code: LedgerAccountCode, currency: string): Promise<string> {
    await this.accounts
      .createQueryBuilder()
      .insert()
      .values({ serviceId, code, type: LEDGER_ACCOUNT_TYPES[code], currency })
      .orIgnore()
      .execute();
    const account = await this.accounts.findOneByOrFail({ serviceId, code, currency });
    return account.ledgerAccountId;
  }
}
