import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { paginateByCreatedAt } from '../../common/database/cursor-pagination';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { IPageable } from '../../common/interceptors/response.interceptor';
import { AdminActor } from '../../common/types/request-context';
import { Order } from '../../order/domain/order.entity';
import { OutboxEvent } from '../../outbox/domain/outbox-event.entity';
import { WebhookDelivery } from '../../outbox/domain/webhook-delivery.entity';
import { PaymentStatus } from '../../payment/constants/payment.constants';
import { Payment } from '../../payment/domain/payment.entity';
import { PaymentReconciler } from '../../payment/payment-reconciler';
import { Service } from '../../service/domain/service.entity';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminAuditAction, AuditTargetType } from '../audit/constants/admin-audit.constants';
import { ListUnknownPaymentsQueryDto, ListWebhookDeliveriesQueryDto } from './dto/request/admin-ops.query.dto';

const DEFAULT_UNKNOWN_LIMIT = 50;

export interface DeliveryView {
  delivery: WebhookDelivery;
  event: OutboxEvent;
}

/**
 * 운영 큐: 자동 처리(발송 재시도·대사 배치)가 결론을 못 낸 건을 사람이 처리한다.
 * 쓰기는 대상 행 락 → 도메인 행위(바뀌었는지) → 저장 → 감사 로그, 한 트랜잭션 (CLAUDE.md 6.5).
 */
@Injectable()
export class AdminOpsService {
  constructor(
    @InjectRepository(WebhookDelivery) private readonly deliveries: Repository<WebhookDelivery>,
    @InjectRepository(OutboxEvent) private readonly events: Repository<OutboxEvent>,
    @InjectRepository(Service) private readonly services: Repository<Service>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly reconciler: PaymentReconciler,
    private readonly audit: AdminAuditService,
  ) {}

  async listWebhookDeliveries(query: ListWebhookDeliveriesQueryDto): Promise<IPageable<DeliveryView>> {
    const filtered = this.deliveries.createQueryBuilder('d').where('1 = 1');
    if (query.status) filtered.andWhere('d.status = :status', { status: query.status });
    if (query.serviceId) filtered.andWhere('d.serviceId = :serviceId', { serviceId: query.serviceId });
    const page = await paginateByCreatedAt(filtered, {
      alias: 'd',
      idProperty: 'webhookDeliveryId',
      limit: query.limit,
      cursor: query.cursor,
    });
    return { ...page, data: await this.withEvents(page.data) };
  }

  /** 관리자 재전송. 받는 곳은 서비스의 현재 webhookUrl. 이미 대기·전송 중이면 그대로 200 (감사 로그 없음) */
  @Transactional()
  async redeliver(deliveryId: string, actor: AdminActor, reason?: string): Promise<DeliveryView> {
    const delivery = await this.deliveries.findOne({
      where: { webhookDeliveryId: deliveryId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!delivery) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);

    const service = await this.services.findOneByOrFail({ serviceId: delivery.serviceId });
    if (!service.webhookUrl) {
      throw new BusinessException(ErrorCode.INVALID_REQUEST, {
        errors: [
          {
            field: 'webhookUrl',
            message: '서비스에 webhookUrl이 없어 재전송할 수 없습니다. 먼저 webhookUrl을 등록하세요.',
          },
        ],
      });
    }

    const before = delivery.auditSnapshot();
    if (delivery.redeliver(new Date(), service.webhookUrl)) {
      await this.deliveries.save(delivery);
      await this.audit.record({
        actor,
        action: AdminAuditAction.WEBHOOK_REDELIVERED,
        targetType: AuditTargetType.WEBHOOK_DELIVERY,
        targetId: delivery.webhookDeliveryId,
        serviceId: delivery.serviceId,
        before,
        after: delivery.auditSnapshot(),
        reason,
      });
    }
    const [view] = await this.withEvents([delivery]);
    return view;
  }

  /** 대사 대기 결제 (IN_PROGRESS·UNKNOWN), 오래된 순 */
  async listUnknownPayments(
    query: ListUnknownPaymentsQueryDto,
  ): Promise<IPageable<{ payment: Payment; order: Order }>> {
    const where = {
      status: In([PaymentStatus.IN_PROGRESS, PaymentStatus.UNKNOWN]),
      ...(query.serviceId ? { serviceId: query.serviceId } : {}),
    };
    const [payments, totalCount] = await this.payments.findAndCount({
      where,
      order: { createdAt: 'ASC' },
      take: query.limit ?? DEFAULT_UNKNOWN_LIMIT,
    });
    return { data: await this.withOrders(payments), totalCount, nextCursor: null };
  }

  /** 수동 대사: 토스 조회로 지금 확정. 확정했을 때만 같은 트랜잭션에서 감사 로그 */
  async reconcile(
    paymentId: string,
    actor: AdminActor,
    reason?: string,
  ): Promise<{ resolved: boolean; payment: Payment; order: Order }> {
    if (!(await this.payments.existsBy({ paymentId }))) throw new BusinessException(ErrorCode.PAYMENT_NOT_FOUND);

    const { resolved, payment } = await this.reconciler.reconcileOne(paymentId, (before, after) =>
      this.audit.record({
        actor,
        action: AdminAuditAction.PAYMENT_RECONCILED,
        targetType: AuditTargetType.PAYMENT,
        targetId: after.paymentId,
        serviceId: after.serviceId,
        before,
        after: { status: after.status },
        reason,
      }),
    );
    const [view] = await this.withOrders([payment]);
    return { resolved, ...view };
  }

  private async withEvents(deliveries: WebhookDelivery[]): Promise<DeliveryView[]> {
    const ids = [...new Set(deliveries.map((delivery) => delivery.outboxEventId))];
    const events = new Map(
      (ids.length ? await this.events.findBy({ outboxEventId: In(ids) }) : []).map((event) => [
        event.outboxEventId,
        event,
      ]),
    );
    return deliveries.map((delivery) => ({ delivery, event: events.get(delivery.outboxEventId) as OutboxEvent }));
  }

  private async withOrders(payments: Payment[]): Promise<{ payment: Payment; order: Order }[]> {
    const ids = [...new Set(payments.map((payment) => payment.orderId))];
    const orders = new Map(
      (ids.length ? await this.orders.findBy({ orderId: In(ids) }) : []).map((order) => [order.orderId, order]),
    );
    return payments.map((payment) => ({ payment, order: orders.get(payment.orderId) as Order }));
  }
}
