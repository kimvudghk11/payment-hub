import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import { bigintAmountTransformer } from '../../common/database/bigint-amount.transformer';
import type { Order } from './order.entity';

/** 주문 항목. 상품명·단가는 결제 시점 스냅샷 */
@Entity({ name: 'tb_order_item' })
export class OrderItem extends BaseEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  orderItemId: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  /** 복합 FK용 (주문·상품 유형 소유 서비스 일치를 DB가 강제) */
  @Column({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  @Column({ name: 'line_no', type: 'smallint' })
  lineNo: number;

  /** tb_service_product_type 화이트리스트 코드 */
  @Column({ name: 'product_type', type: 'varchar', length: 50 })
  productType: string;

  /** 서비스 쪽 상품 ID */
  @Column({ name: 'external_product_id', type: 'varchar', length: 100 })
  externalProductId: string;

  @Column({ name: 'product_name', type: 'varchar', length: 100 })
  productName: string;

  @Column({ name: 'unit_price', type: 'bigint', transformer: bigintAmountTransformer })
  unitPrice: number;

  @Column({ name: 'quantity', type: 'integer' })
  quantity: number;

  /** = unit_price * quantity */
  @Column({ name: 'amount', type: 'bigint', transformer: bigintAmountTransformer })
  amount: number;

  /** 부분 취소 누적 수량. 취소 항목 기록과 같은 트랜잭션에서 갱신 */
  @Column({ name: 'canceled_quantity', type: 'integer' })
  canceledQuantity: number;

  @ManyToOne('Order', (order: Order) => order.items)
  @JoinColumn([
    { name: 'order_id', referencedColumnName: 'orderId' },
    { name: 'service_id', referencedColumnName: 'serviceId' },
  ])
  order: Order;

  /** 주문 생성 시에만 만든다 (Order.create). 금액 = 단가 × 수량 */
  static create(params: { orderId: string; serviceId: string; lineNo: number; item: OrderItemInput }): OrderItem {
    const orderItem = new OrderItem();
    orderItem.orderId = params.orderId;
    orderItem.serviceId = params.serviceId;
    orderItem.lineNo = params.lineNo;
    orderItem.productType = params.item.productType;
    orderItem.externalProductId = params.item.externalProductId;
    orderItem.productName = params.item.productName;
    orderItem.unitPrice = params.item.unitPrice;
    orderItem.quantity = params.item.quantity;
    orderItem.amount = params.item.unitPrice * params.item.quantity;
    orderItem.canceledQuantity = 0;
    return orderItem;
  }

  /** 환불 확정 시 취소 수량 누적 (취소 항목 기록과 같은 트랜잭션) */
  addCanceledQuantity(quantity: number): void {
    if (this.canceledQuantity + quantity > this.quantity) {
      throw new Error(`주문 항목 ${this.orderItemId}: 취소 수량이 수량(${this.quantity})을 넘음`);
    }
    this.canceledQuantity += quantity;
  }

  /** 멱등 비교용: 서비스가 보낸 값만 (순번·금액·취소 수량 같은 파생값 제외) */
  toInput(): OrderItemInput {
    return {
      productType: this.productType,
      externalProductId: this.externalProductId,
      productName: this.productName,
      unitPrice: this.unitPrice,
      quantity: this.quantity,
    };
  }
}

export interface OrderItemInput {
  productType: string;
  externalProductId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
}
