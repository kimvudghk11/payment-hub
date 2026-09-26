import { createHash } from 'crypto';
import { Order } from '../../src/order/domain/order.entity';
import { CardType, PaymentMethodType, PaymentStatus, PaymentType } from '../../src/payment/constants/payment.constants';
import { Payment } from '../../src/payment/domain/payment.entity';
import { TossPayment } from '../../src/pg/toss-payment.types';

const order = (): Order =>
  Order.create({
    serviceId: 'svc-1',
    externalOrderId: 'order-0001',
    externalUserId: 'user-123',
    orderName: '프로 요금제 1개월',
    currency: 'KRW',
    items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 30000, quantity: 1 }],
    totalAmount: 30000,
    expiresAt: new Date('2026-09-27T01:30:00.000Z'),
  });

const started = (): Payment => Payment.startConfirm({ order: order(), paymentKey: 'tgen_abc' });

const tossPayment = (overrides: Partial<TossPayment> = {}): TossPayment => ({
  paymentKey: 'tgen_abc',
  orderId: 'order-id',
  status: 'DONE',
  method: '카드',
  totalAmount: 30000,
  currency: 'KRW',
  approvedAt: '2026-09-27T01:16:03+09:00',
  card: { issuerCode: '11', number: '433012******123*', installmentPlanMonths: 3, cardType: '신용' },
  receipt: { url: 'https://dashboard.tosspayments.com/receipt/abc' },
  ...overrides,
});

describe('Payment.startConfirm', () => {
  it('토스 호출 전 IN_PROGRESS로 먼저 기록할 결제를 만든다 — 금액은 주문 결제 금액', () => {
    const source = order();
    const payment = Payment.startConfirm({ order: source, paymentKey: 'tgen_abc' });

    expect(payment).toMatchObject({
      orderId: source.orderId,
      serviceId: 'svc-1',
      billingKeyId: null,
      provider: 'TOSS',
      paymentType: PaymentType.NORMAL,
      providerPaymentKey: 'tgen_abc',
      currency: 'KRW',
      amount: 30000,
      refundedAmount: 0,
      status: PaymentStatus.IN_PROGRESS,
      methodType: null,
      approvedAt: null,
    });
  });

  it('멱등키는 paymentKey에서 만든다 — 같은 paymentKey면 같은 키, 길이는 컬럼 한도(100) 이내', () => {
    const longKey = 'x'.repeat(200);
    const payment = Payment.startConfirm({ order: order(), paymentKey: longKey });

    expect(payment.idempotencyKey).toBe(`confirm:${createHash('sha256').update(longKey).digest('hex')}`);
    expect(payment.idempotencyKey.length).toBeLessThanOrEqual(100);
  });
});

describe('Payment.applyTossPayment — 결제 수단 분류', () => {
  it('카드 승인: DONE + 카드사·카드 종류·마스킹 번호·할부·영수증·승인 시각', () => {
    const payment = started();
    const response = tossPayment();
    payment.applyTossPayment(response);

    expect(payment).toMatchObject({
      status: PaymentStatus.DONE,
      method: '카드',
      methodType: PaymentMethodType.CARD,
      cardCompanyCode: '11',
      cardType: CardType.CREDIT,
      cardNumberMasked: '433012******123*',
      installmentMonths: 3,
      receiptUrl: 'https://dashboard.tosspayments.com/receipt/abc',
      approvedAt: new Date('2026-09-26T16:16:03.000Z'),
    });
    expect(payment.providerResponse).toEqual(response);
  });

  it.each([
    ['신용', CardType.CREDIT],
    ['체크', CardType.CHECK],
    ['기프트', CardType.GIFT],
    ['미확인', CardType.UNKNOWN],
    [null, CardType.UNKNOWN],
  ])('카드 종류 %s → %s', (tossCardType, expected) => {
    const payment = started();
    payment.applyTossPayment(
      tossPayment({ card: { issuerCode: '11', number: null, installmentPlanMonths: 0, cardType: tossCardType } }),
    );
    expect(payment.cardType).toBe(expected);
  });

  it('가상계좌 발급: WAITING_FOR_DEPOSIT + 은행·계좌·입금 기한, 승인 시각은 아직 없음', () => {
    const payment = started();
    payment.applyTossPayment(
      tossPayment({
        status: 'WAITING_FOR_DEPOSIT',
        method: '가상계좌',
        card: null,
        approvedAt: null,
        virtualAccount: { accountNumber: 'X6505636518308', bankCode: '20', dueDate: '2026-09-27T23:59:59+09:00' },
      }),
    );

    expect(payment).toMatchObject({
      status: PaymentStatus.WAITING_FOR_DEPOSIT,
      methodType: PaymentMethodType.VIRTUAL_ACCOUNT,
      bankCode: '20',
      virtualAccountNumber: 'X6505636518308',
      virtualAccountDueAt: new Date('2026-09-27T14:59:59.000Z'),
      approvedAt: null,
      cardType: null,
    });
  });

  it('간편결제: EASY_PAY + 간편결제사, 카드로 결제했으면 카드 정보도 채운다', () => {
    const payment = started();
    payment.applyTossPayment(tossPayment({ method: '간편결제', easyPay: { provider: '토스페이' } }));

    expect(payment).toMatchObject({
      methodType: PaymentMethodType.EASY_PAY,
      easyPayProvider: '토스페이',
      cardCompanyCode: '11',
    });
  });

  it.each([
    ['계좌이체', PaymentMethodType.TRANSFER],
    ['휴대폰', PaymentMethodType.MOBILE_PHONE],
    ['문화상품권', PaymentMethodType.GIFT_CERTIFICATE],
    ['도서문화상품권', PaymentMethodType.GIFT_CERTIFICATE],
    ['게임문화상품권', PaymentMethodType.GIFT_CERTIFICATE],
    ['CARD', PaymentMethodType.CARD],
    ['VIRTUAL_ACCOUNT', PaymentMethodType.VIRTUAL_ACCOUNT],
    ['알 수 없는 수단', null],
  ])('토스 method %s → %s', (method, expected) => {
    const payment = started();
    payment.applyTossPayment(tossPayment({ method, card: null, transfer: { bankCode: '88' } }));
    expect(payment.methodType).toBe(expected);
    expect(payment.method).toBe(method);
  });

  it('계좌이체는 은행 코드를 채운다', () => {
    const payment = started();
    payment.applyTossPayment(tossPayment({ method: '계좌이체', card: null, transfer: { bankCode: '88' } }));
    expect(payment.bankCode).toBe('88');
  });

  it('토스가 DONE·WAITING_FOR_DEPOSIT 외 상태를 주면 UNKNOWN으로 두고 대사가 확정한다', () => {
    const payment = started();
    payment.applyTossPayment(tossPayment({ status: 'IN_PROGRESS' }));
    expect(payment.status).toBe(PaymentStatus.UNKNOWN);
  });

  it('IN_PROGRESS·UNKNOWN이 아닌 결제에는 반영할 수 없다', () => {
    const payment = started();
    payment.applyTossPayment(tossPayment());
    expect(() => payment.applyTossPayment(tossPayment())).toThrow('DONE');
  });
});

describe('Payment.markFailed / markUnknown', () => {
  it('실패는 토스 원본 코드·메시지를 보존한다', () => {
    const payment = started();
    payment.markFailed({ code: 'REJECT_CARD_PAYMENT', message: '한도초과 혹은 잔액부족', response: { code: 'X' } });

    expect(payment).toMatchObject({
      status: PaymentStatus.FAILED,
      failureCode: 'REJECT_CARD_PAYMENT',
      failureMessage: '한도초과 혹은 잔액부족',
      providerResponse: { code: 'X' },
    });
  });

  it('결과를 모르면 UNKNOWN', () => {
    const payment = started();
    payment.markUnknown(null);
    expect(payment.status).toBe(PaymentStatus.UNKNOWN);
  });

  it('확정된 결제는 실패·불명으로 바꿀 수 없다', () => {
    const payment = started();
    payment.applyTossPayment(tossPayment());
    expect(() => payment.markFailed({ code: 'X', message: 'x', response: null })).toThrow('DONE');
    expect(() => payment.markUnknown(null)).toThrow('DONE');
  });
});

describe('Payment.refundableAmount', () => {
  it('승인된 결제는 금액 − 환불 누적', () => {
    const payment = started();
    payment.applyTossPayment(tossPayment());
    payment.refundedAmount = 3000;
    expect(payment.refundableAmount).toBe(27000);
  });

  it.each([PaymentStatus.IN_PROGRESS, PaymentStatus.UNKNOWN, PaymentStatus.WAITING_FOR_DEPOSIT, PaymentStatus.FAILED])(
    '%s 결제는 환불 가능 금액 0',
    (status) => {
      const payment = started();
      payment.status = status;
      expect(payment.refundableAmount).toBe(0);
    },
  );
});
