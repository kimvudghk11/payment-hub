import { randomUUID } from 'crypto';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import { bigintAmountTransformer } from '../../common/database/bigint-amount.transformer';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { OrderStatus } from '../constants/order.constants';
import { OrderItem, OrderItemInput } from './order-item.entity';

/** 서비스가 사전 등록한 주문. 금액은 등록 시점에 고정되고 confirm 시 total_amount와 대조한다. */
@Entity({ name: 'tb_order' })
export class Order extends BaseEntity {
  /** 토스 orderId로 사용 */
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  orderId: string;

  @Column({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  /** 서비스 쪽 주문번호. (service_id, external_order_id) = 주문 생성 멱등키 */
  @Column({ name: 'external_order_id', type: 'varchar', length: 100 })
  externalOrderId: string;

  @Column({ name: 'external_user_id', type: 'varchar', length: 100 })
  externalUserId: string;

  @Column({ name: 'external_subscription_id', type: 'varchar', length: 100, nullable: true })
  externalSubscriptionId: string | null;

  /** 토스 orderName (최대 100자) */
  @Column({ name: 'order_name', type: 'varchar', length: 100 })
  orderName: string;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency: string;

  /** = sum(order_item.amount). DB가 강제하지 못하므로 엔티티에서 검증 */
  @Column({ name: 'original_amount', type: 'bigint', transformer: bigintAmountTransformer })
  originalAmount: number;

  /** 서비스 정의 값. 저장만 */
  @Column({ name: 'discount_type', type: 'varchar', length: 50, nullable: true })
  discountType: string | null;

  @Column({ name: 'discount_amount', type: 'bigint', transformer: bigintAmountTransformer })
  discountAmount: number;

  /** 실제 청구액 = original_amount - discount_amount. confirm 시 이 값과 비교 */
  @Column({ name: 'total_amount', type: 'bigint', transformer: bigintAmountTransformer })
  totalAmount: number;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status: OrderStatus;

  /** 이 시각 이후 confirm 거부 */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  /** 서비스 맥락. hub는 해석하지 않는다 */
  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @OneToMany(() => OrderItem, (item) => item.order)
  items: OrderItem[];

  /**
   * 주문 사전 등록. 할인·금액 계산은 서비스 책임이고 hub는 합계가 맞는지만 확인한다.
   * sum(항목 금액) = 원금, 원금 − 할인 = 결제 금액(> 0)이 아니면 ORDER_AMOUNT_INVALID.
   * 주문 ID는 여기서 만든다 (항목이 같은 ID를 참조해야 하고, 토스 orderId로도 쓰인다).
   */
  static create(params: CreateOrderParams): Order {
    const orderId = randomUUID();
    const items = params.items.map((item, index) =>
      OrderItem.create({ orderId, serviceId: params.serviceId, lineNo: index + 1, item }),
    );
    const discountAmount = params.discountAmount ?? 0;
    assertAmounts(items, discountAmount, params.totalAmount);

    const order = new Order();
    order.orderId = orderId;
    order.serviceId = params.serviceId;
    order.externalOrderId = params.externalOrderId;
    order.externalUserId = params.externalUserId;
    order.externalSubscriptionId = params.externalSubscriptionId ?? null;
    order.orderName = params.orderName;
    order.currency = params.currency;
    order.originalAmount = sumAmounts(items);
    order.discountType = params.discountType ?? null;
    order.discountAmount = discountAmount;
    order.totalAmount = params.totalAmount;
    order.status = OrderStatus.PENDING;
    order.expiresAt = params.expiresAt;
    order.paidAt = null;
    order.metadata = params.metadata ?? null;
    order.items = items;
    return order;
  }

  /**
   * 같은 (서비스, externalOrderId) 재요청이 같은 주문인지. 같으면 기존 주문을 돌려주고, 다르면 409.
   * 만료 시각은 요청 시점마다 달라지므로 비교하지 않는다. items가 로드되어 있어야 한다.
   */
  matches(params: CreateOrderParams): boolean {
    return (
      canonicalJson(this.comparable()) ===
      canonicalJson({
        externalUserId: params.externalUserId,
        externalSubscriptionId: params.externalSubscriptionId ?? null,
        orderName: params.orderName,
        currency: params.currency,
        discountType: params.discountType ?? null,
        discountAmount: params.discountAmount ?? 0,
        totalAmount: params.totalAmount,
        metadata: params.metadata ?? null,
        items: params.items,
      })
    );
  }

  /**
   * 결제 승인 전 검증. 만료는 만료 배치가 돌기 전이어도 시각으로 판단한다.
   * 금액은 서비스가 결제창에 넘긴 값(토스 successUrl의 amount)과 등록 시 고정한 결제 금액을 대조해 변조를 막는다.
   */
  assertConfirmable(amount: number, now: Date): void {
    if (PAID_STATUSES.has(this.status)) throw new BusinessException(ErrorCode.ORDER_ALREADY_PAID);
    if (this.status === OrderStatus.EXPIRED || this.expiresAt.getTime() <= now.getTime()) {
      throw new BusinessException(ErrorCode.ORDER_EXPIRED);
    }
    if (amount !== this.totalAmount) throw new BusinessException(ErrorCode.PAYMENT_AMOUNT_MISMATCH);
  }

  markPaid(paidAt: Date): void {
    if (this.status !== OrderStatus.PENDING) {
      throw new Error(`주문 ${this.orderId}: ${this.status} → PAID 전이 불가`);
    }
    this.status = OrderStatus.PAID;
    this.paidAt = paidAt;
  }

  private comparable() {
    return {
      externalUserId: this.externalUserId,
      externalSubscriptionId: this.externalSubscriptionId,
      orderName: this.orderName,
      currency: this.currency,
      discountType: this.discountType,
      discountAmount: this.discountAmount,
      totalAmount: this.totalAmount,
      metadata: this.metadata,
      items: [...this.items].sort((a, b) => a.lineNo - b.lineNo).map((item) => item.toInput()),
    };
  }
}

export interface CreateOrderParams {
  serviceId: string;
  externalOrderId: string;
  externalUserId: string;
  externalSubscriptionId?: string | null;
  orderName: string;
  currency: string;
  items: OrderItemInput[];
  discountType?: string | null;
  discountAmount?: number;
  totalAmount: number;
  expiresAt: Date;
  metadata?: Record<string, unknown> | null;
}

const PAID_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PAID,
  OrderStatus.PARTIAL_CANCELED,
  OrderStatus.CANCELED,
]);

const sumAmounts = (items: OrderItem[]): number => items.reduce((sum, item) => sum + item.amount, 0);

const assertAmounts = (items: OrderItem[], discountAmount: number, totalAmount: number): void => {
  const originalAmount = sumAmounts(items);
  const expectedTotalAmount = originalAmount - discountAmount;
  const valid =
    items.length > 0 &&
    items.every((item) => Number.isSafeInteger(item.amount)) &&
    Number.isSafeInteger(originalAmount) &&
    discountAmount <= originalAmount &&
    totalAmount > 0 &&
    totalAmount === expectedTotalAmount;
  if (!valid) {
    throw new BusinessException(ErrorCode.ORDER_AMOUNT_INVALID, {
      originalAmount,
      discountAmount,
      expectedTotalAmount,
      totalAmount,
    });
  }
};

/** 키 순서와 무관한 JSON (metadata 비교용) */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
