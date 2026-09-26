import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { bigintAmountTransformer } from '../../common/database/bigint-amount.transformer';
import type { PaymentCancel } from './payment-cancel.entity';

/** 부분 환불 시 어떤 주문 항목을 몇 개 취소했는지 (선택 입력). 시간 컬럼 없음 */
@Entity({ name: 'tb_payment_cancel_item' })
export class PaymentCancelItem {
  @PrimaryColumn({ name: 'cancel_id', type: 'uuid' })
  paymentCancelId: string;

  /** 주문 애그리거트 참조는 ID로만 */
  @PrimaryColumn({ name: 'order_item_id', type: 'uuid' })
  orderItemId: string;

  @Column({ name: 'quantity', type: 'integer' })
  quantity: number;

  @Column({ name: 'amount', type: 'bigint', transformer: bigintAmountTransformer })
  amount: number;

  @ManyToOne('PaymentCancel', (cancel: PaymentCancel) => cancel.items)
  @JoinColumn({ name: 'cancel_id', referencedColumnName: 'paymentCancelId' })
  cancel: PaymentCancel;

  static create(
    paymentCancelId: string,
    item: { orderItemId: string; quantity: number; amount: number },
  ): PaymentCancelItem {
    return Object.assign(new PaymentCancelItem(), { paymentCancelId, ...item });
  }
}
