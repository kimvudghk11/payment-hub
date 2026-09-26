import { OrderStatus } from '../../src/order/constants/order.constants';
import { OrderItem } from '../../src/order/domain/order-item.entity';
import { Order } from '../../src/order/domain/order.entity';
import { CancelRequestedBy, PaymentCancelStatus, PaymentStatus } from '../../src/payment/constants/payment.constants';
import { PaymentCancel } from '../../src/payment/domain/payment-cancel.entity';
import { CancelRequest, Payment } from '../../src/payment/domain/payment.entity';
import { expectBusinessError } from '../support/business-error';

/** 프로 요금제 24000 × 1 + 저장공간 3000 × 2 = 30000 */
const paidOrder = (): Order => {
  const order = Order.create({
    serviceId: 'svc-1',
    externalOrderId: 'order-1',
    externalUserId: 'user-1',
    orderName: '프로 요금제 외 1건',
    currency: 'KRW',
    items: [
      { productType: 'PLAN', externalProductId: 'pro', productName: '프로 요금제', unitPrice: 24000, quantity: 1 },
      { productType: 'ADDON', externalProductId: 'storage', productName: '저장공간', unitPrice: 3000, quantity: 2 },
    ],
    totalAmount: 30000,
    expiresAt: new Date('2026-09-27T01:30:00.000Z'),
  });
  order.items.forEach((item, index) => (item.orderItemId = `item-${index + 1}`));
  order.markPaid(new Date('2026-09-27T01:16:03.000Z'));
  return order;
};

const donePayment = (order: Order): Payment => {
  const payment = Payment.startConfirm({ order, paymentKey: 'tgen_abc' });
  payment.paymentId = 'pay-1';
  payment.status = PaymentStatus.DONE;
  payment.cancels = [];
  return payment;
};

const request = (overrides: Partial<CancelRequest> = {}): CancelRequest => ({
  idempotencyKey: 'refund-1',
  amount: 3000,
  reasonCode: 'USER_REQUEST',
  reasonDetail: '저장공간 1개 환불',
  requestedBy: CancelRequestedBy.SERVICE,
  items: [{ orderItemId: 'item-2', quantity: 1, amount: 3000 }],
  ...overrides,
});

const setup = () => {
  const order = paidOrder();
  return { order, payment: donePayment(order) };
};

describe('Payment.requestCancel — 환불 요청 검증', () => {
  it('토스 호출 전에 기록할 REQUESTED 취소를 만든다 (항목 포함)', () => {
    const { order, payment } = setup();
    const cancel = payment.requestCancel(request(), order.items);

    expect(cancel).toMatchObject({
      paymentId: 'pay-1',
      serviceId: 'svc-1',
      idempotencyKey: 'refund-1',
      amount: 3000,
      reasonCode: 'USER_REQUEST',
      reasonDetail: '저장공간 1개 환불',
      requestedBy: CancelRequestedBy.SERVICE,
      status: PaymentCancelStatus.REQUESTED,
      providerTransactionKey: null,
      canceledAt: null,
    });
    expect(cancel.paymentCancelId).toMatch(/^[0-9a-f-]{36}$/);
    expect(cancel.items).toEqual([
      expect.objectContaining({
        paymentCancelId: cancel.paymentCancelId,
        orderItemId: 'item-2',
        quantity: 1,
        amount: 3000,
      }),
    ]);
    // 결제는 취소가 확정될 때까지 그대로
    expect(payment).toMatchObject({ status: PaymentStatus.DONE, refundedAmount: 0 });
    expect(payment.cancels).toContain(cancel);
  });

  it('항목 없이 금액만으로도 환불할 수 있다 (일할 환불 등)', () => {
    const { order, payment } = setup();
    expect(payment.requestCancel(request({ amount: 12345, items: [] }), order.items).items).toEqual([]);
  });

  it.each([
    PaymentStatus.IN_PROGRESS,
    PaymentStatus.UNKNOWN,
    PaymentStatus.WAITING_FOR_DEPOSIT,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELED,
  ])('%s 결제는 409 PAYMENT_NOT_CANCELABLE', (status) => {
    const { order, payment } = setup();
    payment.status = status;
    expectBusinessError(() => payment.requestCancel(request(), order.items), 'PAYMENT_NOT_CANCELABLE');
  });

  it('환불 가능 금액을 넘으면 400 CANCEL_AMOUNT_EXCEEDED', () => {
    const { order, payment } = setup();
    payment.refundedAmount = 28000;
    payment.status = PaymentStatus.PARTIAL_CANCELED;
    expectBusinessError(
      () => payment.requestCancel(request({ amount: 3000, items: [] }), order.items),
      'CANCEL_AMOUNT_EXCEEDED',
    );
  });

  it('처리 중인(REQUESTED·UNKNOWN) 환불 금액도 뺀다 — 동시에 들어온 부분 환불 합계가 결제 금액을 넘지 않게', () => {
    const { order, payment } = setup();
    payment.requestCancel(request({ idempotencyKey: 'a', amount: 20000, items: [] }), order.items);

    let detail: unknown;
    try {
      payment.requestCancel(request({ idempotencyKey: 'b', amount: 10001, items: [] }), order.items);
    } catch (error) {
      detail = (error as { detail?: unknown }).detail;
    }
    expect(detail).toEqual({ refundableAmount: 10000 });
    expect(() =>
      payment.requestCancel(request({ idempotencyKey: 'c', amount: 10000, items: [] }), order.items),
    ).not.toThrow();
  });

  it('실패한 환불은 금액을 잡아두지 않는다', () => {
    const { order, payment } = setup();
    const failed = payment.requestCancel(request({ idempotencyKey: 'a', amount: 30000, items: [] }), order.items);
    failed.markFailed({ code: 'X', message: 'x' });

    expect(() =>
      payment.requestCancel(request({ idempotencyKey: 'b', amount: 30000, items: [] }), order.items),
    ).not.toThrow();
  });

  describe('항목 검증 → 400 INVALID_REQUEST (필드별 메시지)', () => {
    it('이 주문의 항목이 아니면', () => {
      const { order, payment } = setup();
      expectBusinessError(
        () =>
          payment.requestCancel(request({ items: [{ orderItemId: 'other', quantity: 1, amount: 3000 }] }), order.items),
        'INVALID_REQUEST',
      );
    });

    it('취소 가능 수량(수량 − 취소된 수량 − 처리 중 수량)을 넘으면', () => {
      const { order, payment } = setup();
      order.items[1].canceledQuantity = 1;
      payment.requestCancel(request({ idempotencyKey: 'a' }), order.items); // 처리 중 1개

      let errors: unknown;
      try {
        payment.requestCancel(request({ idempotencyKey: 'b' }), order.items);
      } catch (error) {
        errors = (error as { detail?: { errors?: unknown } }).detail?.errors;
      }
      expect(errors).toEqual([{ field: 'items.0.quantity', message: '취소 가능 수량(0개)을 넘었습니다.' }]);
    });

    it('항목 금액 합계가 환불 금액과 다르면', () => {
      const { order, payment } = setup();
      expectBusinessError(() => payment.requestCancel(request({ amount: 5000 }), order.items), 'INVALID_REQUEST');
    });

    it('같은 항목을 두 번 적으면', () => {
      const { order, payment } = setup();
      const item = { orderItemId: 'item-2', quantity: 1, amount: 1500 };
      expectBusinessError(
        () => payment.requestCancel(request({ items: [item, item] }), order.items),
        'INVALID_REQUEST',
      );
    });
  });
});

describe('취소 확정 — PaymentCancel.markDone → Payment·Order·OrderItem 반영', () => {
  const canceledAt = new Date('2026-09-28T00:00:00.000Z');

  it('부분 환불: 취소 DONE, 결제 PARTIAL_CANCELED·환불 누적, 주문 PARTIAL_CANCELED, 항목 취소 수량 누적', () => {
    const { order, payment } = setup();
    const cancel = payment.requestCancel(request(), order.items);

    cancel.markDone({ transactionKey: 'tx-1', canceledAt });
    payment.applyCanceled(cancel);
    order.applyRefund(payment, cancel.items);

    expect(cancel).toMatchObject({ status: PaymentCancelStatus.DONE, providerTransactionKey: 'tx-1', canceledAt });
    expect(payment).toMatchObject({ status: PaymentStatus.PARTIAL_CANCELED, refundedAmount: 3000 });
    expect(payment.refundableAmount).toBe(27000);
    expect(order.status).toBe(OrderStatus.PARTIAL_CANCELED);
    expect(order.items.map((item: OrderItem) => item.canceledQuantity)).toEqual([0, 1]);
  });

  it('전액 환불: 결제 CANCELED, 주문 CANCELED, 환불 가능 금액 0', () => {
    const { order, payment } = setup();
    const cancel = payment.requestCancel(request({ amount: 30000, items: [] }), order.items);

    cancel.markDone({ transactionKey: 'tx-1', canceledAt });
    payment.applyCanceled(cancel);
    order.applyRefund(payment, cancel.items);

    expect(payment).toMatchObject({ status: PaymentStatus.CANCELED, refundedAmount: 30000 });
    expect(payment.refundableAmount).toBe(0);
    expect(order.status).toBe(OrderStatus.CANCELED);
  });

  it('DONE이 아닌 취소는 결제에 반영할 수 없다', () => {
    const { order, payment } = setup();
    const cancel = payment.requestCancel(request(), order.items);
    expect(() => payment.applyCanceled(cancel)).toThrow('REQUESTED');
  });

  it('취소 결과는 REQUESTED·UNKNOWN에서만 바꿀 수 있다', () => {
    const { order, payment } = setup();
    const cancel: PaymentCancel = payment.requestCancel(request(), order.items);
    cancel.markUnknown();
    expect(cancel.status).toBe(PaymentCancelStatus.UNKNOWN);
    cancel.markDone({ transactionKey: 'tx-1', canceledAt });
    expect(() => cancel.markFailed({ code: 'X', message: 'x' })).toThrow('DONE');
  });
});
