import { OrderStatus } from '../../src/order/constants/order.constants';
import { CreateOrderParams, Order } from '../../src/order/domain/order.entity';
import { expectBusinessError } from '../support/business-error';

const EXPIRES_AT = new Date('2026-09-27T01:30:00.000Z');

const params = (overrides: Partial<CreateOrderParams> = {}): CreateOrderParams => ({
  serviceId: 'svc-1',
  externalOrderId: 'order-0001',
  externalUserId: 'user-123',
  externalSubscriptionId: 'sub-77',
  orderName: '프로 요금제 1개월 외 1건',
  currency: 'KRW',
  items: [
    {
      productType: 'PLAN',
      externalProductId: 'pro-monthly',
      productName: '프로 요금제',
      unitPrice: 29000,
      quantity: 1,
    },
    { productType: 'ADDON', externalProductId: 'storage-10g', productName: '저장공간', unitPrice: 3000, quantity: 2 },
  ],
  discountType: 'COUPON_WELCOME',
  discountAmount: 5000,
  totalAmount: 30000,
  expiresAt: EXPIRES_AT,
  metadata: { plan: 'pro' },
  ...overrides,
});

describe('Order.create', () => {
  it('항목 합계를 원금으로 고정하고 PENDING 주문을 만든다', () => {
    const order = Order.create(params());

    expect(order).toMatchObject({
      serviceId: 'svc-1',
      externalOrderId: 'order-0001',
      originalAmount: 35000,
      discountAmount: 5000,
      totalAmount: 30000,
      status: OrderStatus.PENDING,
      expiresAt: EXPIRES_AT,
      paidAt: null,
    });
    expect(order.orderId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('항목은 순번·금액(단가×수량)을 갖고 같은 주문·서비스에 묶인다', () => {
    const order = Order.create(params());

    expect(order.items.map((item) => [item.lineNo, item.amount, item.orderId, item.serviceId])).toEqual([
      [1, 29000, order.orderId, 'svc-1'],
      [2, 6000, order.orderId, 'svc-1'],
    ]);
    expect(order.items.every((item) => item.canceledQuantity === 0)).toBe(true);
  });

  it('선택 값은 null, 할인은 0으로 채운다', () => {
    const order = Order.create(
      params({
        externalSubscriptionId: undefined,
        discountType: undefined,
        discountAmount: undefined,
        totalAmount: 35000,
        metadata: undefined,
      }),
    );

    expect(order).toMatchObject({
      externalSubscriptionId: null,
      discountType: null,
      discountAmount: 0,
      metadata: null,
    });
  });

  describe('금액 검증 → 400 ORDER_AMOUNT_INVALID', () => {
    it.each([
      ['원금 − 할인 ≠ 결제 금액', { totalAmount: 29999 }],
      ['할인이 원금보다 큼', { discountAmount: 40000, totalAmount: 0 }],
      ['결제 금액이 0', { discountAmount: 35000, totalAmount: 0 }],
      ['항목이 없음', { items: [], discountAmount: 0, totalAmount: 0 }],
    ])('%s', (_, overrides) => {
      expectBusinessError(() => Order.create(params(overrides)), 'ORDER_AMOUNT_INVALID');
    });

    it('합계가 안전 정수 범위를 넘으면 정밀도 손실 대신 거부한다', () => {
      const huge = {
        productType: 'PLAN',
        externalProductId: 'x',
        productName: 'x',
        unitPrice: Number.MAX_SAFE_INTEGER,
        quantity: 2,
      };

      expectBusinessError(
        () => Order.create(params({ items: [huge], discountAmount: 0, totalAmount: 1 })),
        'ORDER_AMOUNT_INVALID',
      );
    });

    it('검증 실패 detail에 계산값을 담아 서비스가 원인을 알 수 있게 한다', () => {
      try {
        Order.create(params({ totalAmount: 29999 }));
        fail('예외가 나야 한다');
      } catch (error) {
        expect((error as { detail: unknown }).detail).toEqual({
          originalAmount: 35000,
          discountAmount: 5000,
          expectedTotalAmount: 30000,
          totalAmount: 29999,
        });
      }
    });
  });
});

describe('Order.matches (주문 등록 멱등 비교)', () => {
  const order = Order.create(params());

  it('같은 내용이면 true (만료 시각은 요청 시점마다 달라지므로 비교하지 않음)', () => {
    expect(order.matches(params({ expiresAt: new Date('2030-01-01T00:00:00Z') }))).toBe(true);
  });

  it.each([
    ['결제 금액', { totalAmount: 29000, discountAmount: 6000 }],
    ['사용자', { externalUserId: 'user-999' }],
    ['주문명', { orderName: '다른 주문' }],
    ['metadata', { metadata: { plan: 'basic' } }],
    [
      '항목 수량',
      {
        items: [
          {
            productType: 'PLAN',
            externalProductId: 'pro-monthly',
            productName: '프로 요금제',
            unitPrice: 29000,
            quantity: 1,
          },
          {
            productType: 'ADDON',
            externalProductId: 'storage-10g',
            productName: '저장공간',
            unitPrice: 3000,
            quantity: 1,
          },
        ],
        totalAmount: 27000,
      },
    ],
  ])('%s가 다르면 false', (_, overrides) => {
    expect(order.matches(params(overrides))).toBe(false);
  });
});

describe('Order.assertConfirmable (결제 승인 전 검증)', () => {
  const NOW = new Date('2026-09-27T01:00:00.000Z');

  it('PENDING·만료 전·금액 일치면 통과', () => {
    expect(() => Order.create(params()).assertConfirmable(30000, NOW)).not.toThrow();
  });

  it('금액이 다르면 400 PAYMENT_AMOUNT_MISMATCH', () => {
    expectBusinessError(() => Order.create(params()).assertConfirmable(29999, NOW), 'PAYMENT_AMOUNT_MISMATCH');
  });

  it('만료 시각이 지났으면 409 ORDER_EXPIRED (만료 배치가 아직 안 돌았어도)', () => {
    expectBusinessError(() => Order.create(params()).assertConfirmable(30000, EXPIRES_AT), 'ORDER_EXPIRED');
  });

  it('EXPIRED 주문은 409 ORDER_EXPIRED', () => {
    const order = Order.create(params());
    order.status = OrderStatus.EXPIRED;
    expectBusinessError(() => order.assertConfirmable(30000, NOW), 'ORDER_EXPIRED');
  });

  it.each([OrderStatus.PAID, OrderStatus.PARTIAL_CANCELED, OrderStatus.CANCELED])(
    '%s 주문은 409 ORDER_ALREADY_PAID',
    (status) => {
      const order = Order.create(params());
      order.status = status;
      expectBusinessError(() => order.assertConfirmable(30000, NOW), 'ORDER_ALREADY_PAID');
    },
  );
});

describe('Order.markPaid', () => {
  it('PENDING → PAID, 결제 시각 기록', () => {
    const order = Order.create(params());
    const paidAt = new Date('2026-09-27T01:16:03.000Z');
    order.markPaid(paidAt);
    expect(order).toMatchObject({ status: OrderStatus.PAID, paidAt });
  });

  it('PENDING이 아니면 전이할 수 없다', () => {
    const order = Order.create(params());
    order.markPaid(new Date());
    expect(() => order.markPaid(new Date())).toThrow('PAID');
  });
});
