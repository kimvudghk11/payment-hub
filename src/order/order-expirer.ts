import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Not, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { OutboxEventType } from '../outbox/constants/outbox.constants';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentStatus } from '../payment/constants/payment.constants';
import { Payment } from '../payment/domain/payment.entity';
import { OrderStatus } from './constants/order.constants';
import { Order } from './domain/order.entity';

export const ORDER_EXPIRY_BATCH_SIZE = 100;

/** 끝난 결제 — 이것만 있는 주문은 만료할 수 있다 */
const DEAD_PAYMENT_STATUSES = [PaymentStatus.FAILED, PaymentStatus.ABORTED, PaymentStatus.EXPIRED];

/**
 * 만료 배치: 결제 없이 만료 시각이 지난 PENDING 주문을 EXPIRED로 바꾸고 ORDER_EXPIRED 이벤트를 발행한다.
 * 살아있는 결제(입금 대기·결과 불명·처리 중)가 있는 주문은 건너뛴다 — 결제가 확정되면 그쪽이 주문을 정리한다.
 * 주문 행 락 + 상태 재확인으로 승인 요청·다른 인스턴스와 겹쳐도 한 번만 만료된다.
 */
@Injectable()
export class OrderExpirer {
  private readonly logger = new Logger(OrderExpirer.name);

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    private readonly outbox: OutboxService,
  ) {}

  async expireDue(
    now: Date = new Date(),
    limit: number = ORDER_EXPIRY_BATCH_SIZE,
  ): Promise<{ expired: number; failed: number }> {
    // 살아있는 결제가 있는 주문은 후보에서 뺀다 (건너뛴 주문이 배치 앞자리를 계속 차지하지 않게)
    const due = await this.orders
      .createQueryBuilder('o')
      .select('o.orderId')
      .where({ status: OrderStatus.PENDING, expiresAt: LessThanOrEqual(now) })
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM tb_payment p WHERE p.order_id = o.id AND p.status NOT IN (:...deadStatuses))`,
        { deadStatuses: DEAD_PAYMENT_STATUSES },
      )
      .orderBy('o.expiresAt', 'ASC')
      .limit(limit)
      .getMany();
    let expired = 0;
    let failed = 0;
    for (const { orderId } of due) {
      try {
        if (await this.expireOne(orderId, now)) expired += 1;
      } catch (error) {
        // 건 단위 격리: 이 주문은 롤백된 채 PENDING으로 남아 다음 배치에서 다시 시도된다
        failed += 1;
        this.logger.error(
          '주문 ' + orderId + ' 만료 실패: ' + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    return { expired, failed };
  }

  @Transactional()
  private async expireOne(orderId: string, now: Date): Promise<boolean> {
    const order = await this.orders.findOne({ where: { orderId }, lock: { mode: 'pessimistic_write' } });
    if (!order) return false;
    const hasLivePayment = await this.payments.existsBy({ orderId, status: Not(In(DEAD_PAYMENT_STATUSES)) });
    if (hasLivePayment || !order.expire(now)) return false;

    await this.orders.save(order);
    await this.outbox.publishOrderEvent(OutboxEventType.ORDER_EXPIRED, order);
    return true;
  }
}
