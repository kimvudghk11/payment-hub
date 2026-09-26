import { LedgerDirection, LedgerTransactionType } from '../../src/ledger/constants/ledger.constants';
import { LedgerTransaction } from '../../src/ledger/domain/ledger-transaction.entity';
import { PaymentCancelStatus, PaymentStatus } from '../../src/payment/constants/payment.constants';
import { PaymentCancel } from '../../src/payment/domain/payment-cancel.entity';
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

describe('LedgerTransaction.paymentCanceled', () => {
  const canceledAt = new Date('2026-09-28T00:00:00.000Z');
  const cancel = Object.assign(new PaymentCancel(), {
    paymentCancelId: 'cancel-1',
    paymentId: 'pay-1',
    serviceId: 'svc-1',
    amount: 3000,
    status: PaymentCancelStatus.DONE,
    canceledAt,
  });
  const refundAccounts = { refundAccountId: 'acc-refund', pgReceivableAccountId: 'acc-receivable' };

  it('환불: 차) 환불(매출 차감) / 대) PG 미수금, 취소 건 단위로 기장 — 사건 시각은 토스 취소 시각', () => {
    const transaction = LedgerTransaction.paymentCanceled(cancel, 'KRW', refundAccounts);

    expect(transaction).toMatchObject({
      serviceId: 'svc-1',
      transactionType: LedgerTransactionType.PAYMENT_CANCELED,
      referenceType: 'PAYMENT_CANCEL',
      referenceId: 'cancel-1',
      occurredAt: canceledAt,
    });
    expect(
      transaction.entries.map(({ ledgerAccountId, direction, amount }) => ({ ledgerAccountId, direction, amount })),
    ).toEqual([
      { ledgerAccountId: 'acc-refund', direction: LedgerDirection.DEBIT, amount: 3000 },
      { ledgerAccountId: 'acc-receivable', direction: LedgerDirection.CREDIT, amount: 3000 },
    ]);
  });

  it('확정되지 않은 취소는 기장하지 않는다', () => {
    const requested = Object.assign(new PaymentCancel(), { ...cancel, status: PaymentCancelStatus.REQUESTED });
    expect(() => LedgerTransaction.paymentCanceled(requested, 'KRW', refundAccounts)).toThrow('REQUESTED');
  });
});
