import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import { bigintAmountTransformer } from '../../common/database/bigint-amount.transformer';
import { OrderStatus } from '../constants/order.constants';
import { OrderItem } from './order-item.entity';

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
}
