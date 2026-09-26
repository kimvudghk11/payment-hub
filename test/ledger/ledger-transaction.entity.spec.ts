import { LedgerDirection, LedgerTransactionType } from '../../src/ledger/constants/ledger.constants';
import { LedgerTransaction } from '../../src/ledger/domain/ledger-transaction.entity';
import { PaymentStatus } from '../../src/payment/constants/payment.constants';
import { Payment } from '../../src/payment/domain/payment.entity';

const approvedAt = new Date('2026-09-27T01:16:03.000Z');

const donePayment = (overrides: Partial<Payment> = {}): Payment =>
  Object.assign(new Payment(), {
    paymentId: 'pay-1',
    serviceId: 'svc-1',
    amount: 30000,
    currency: 'KRW',
    status: PaymentStatus.DONE,
    approvedAt,
    ...overrides,
  });

const accounts = { pgReceivableAccountId: 'acc-receivable', revenueAccountId: 'acc-revenue' };

describe('LedgerTransaction.paymentCaptured', () => {
  it('결제 승인: 차) PG 미수금 / 대) 매출, 같은 금액 — 차변 합 = 대변 합', () => {
    const transaction = LedgerTransaction.paymentCaptured(donePayment(), accounts);

    expect(transaction).toMatchObject({
      serviceId: 'svc-1',
      transactionType: LedgerTransactionType.PAYMENT_CAPTURED,
      referenceType: 'PAYMENT',
      referenceId: 'pay-1',
      occurredAt: approvedAt,
    });
    expect(
      transaction.entries.map(({ ledgerAccountId, direction, amount, currency }) => ({
        ledgerAccountId,
        direction,
        amount,
        currency,
      })),
    ).toEqual([
      { ledgerAccountId: 'acc-receivable', direction: LedgerDirection.DEBIT, amount: 30000, currency: 'KRW' },
      { ledgerAccountId: 'acc-revenue', direction: LedgerDirection.CREDIT, amount: 30000, currency: 'KRW' },
    ]);
  });

  it('분개는 같은 트랜잭션 ID에 묶인다 (저장 전에 ID를 정한다)', () => {
    const transaction = LedgerTransaction.paymentCaptured(donePayment(), accounts);

    expect(transaction.ledgerTransactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(transaction.entries.every((entry) => entry.ledgerTransactionId === transaction.ledgerTransactionId)).toBe(
      true,
    );
  });

  it('승인되지 않은 결제는 기장하지 않는다', () => {
    expect(() =>
      LedgerTransaction.paymentCaptured(
        donePayment({ status: PaymentStatus.WAITING_FOR_DEPOSIT, approvedAt: null }),
        accounts,
      ),
    ).toThrow('WAITING_FOR_DEPOSIT');
  });
});
