import { In, Repository } from 'typeorm';
import { paginateByCreatedAt } from '../common/database/cursor-pagination';
import { IPageable } from '../common/interceptors/response.interceptor';
import { Order } from '../order/domain/order.entity';
import { PaymentMethodType, PaymentStatus } from './constants/payment.constants';
import { Payment } from './domain/payment.entity';

export interface PaymentSearchFilters {
  /** 서비스 API는 항상 채운다 (자기 서비스만). admin은 선택 */
  serviceId?: string;
  externalUserId?: string;
  externalOrderId?: string;
  externalSubscriptionId?: string;
  status?: PaymentStatus[];
  methodType?: PaymentMethodType;
  cardCompanyCode?: string;
  /** 토스 paymentKey */
  paymentKey?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

/**
 * 결제 검색 (최신순 cursor 페이징). 주문의 외부 ID로 거르기 위해 주문과 조인하고, 결과마다 주문을 붙여 준다.
 * 서비스 API와 admin API가 같은 필터 규칙을 쓴다 — 범위 제한(serviceId)은 호출하는 쪽이 정한다.
 */
export const searchPayments = async (
  repositories: { payments: Repository<Payment>; orders: Repository<Order> },
  filters: PaymentSearchFilters,
): Promise<IPageable<{ payment: Payment; order: Order }>> => {
  const filtered = repositories.payments
    .createQueryBuilder('p')
    .innerJoin(Order, 'o', 'o.orderId = p.orderId AND o.serviceId = p.serviceId')
    .where('1 = 1');
  if (filters.serviceId) filtered.andWhere('p.serviceId = :serviceId', { serviceId: filters.serviceId });
  if (filters.externalUserId) filtered.andWhere('o.externalUserId = :eu', { eu: filters.externalUserId });
  if (filters.externalOrderId) filtered.andWhere('o.externalOrderId = :eo', { eo: filters.externalOrderId });
  if (filters.externalSubscriptionId) {
    filtered.andWhere('o.externalSubscriptionId = :es', { es: filters.externalSubscriptionId });
  }
  if (filters.status?.length) filtered.andWhere('p.status IN (:...statuses)', { statuses: filters.status });
  if (filters.methodType) filtered.andWhere('p.methodType = :methodType', { methodType: filters.methodType });
  if (filters.cardCompanyCode) filtered.andWhere('p.cardCompanyCode = :cc', { cc: filters.cardCompanyCode });
  if (filters.paymentKey) filtered.andWhere('p.providerPaymentKey = :pk', { pk: filters.paymentKey });
  if (filters.from) filtered.andWhere('p.createdAt >= :from', { from: new Date(filters.from) });
  if (filters.to) filtered.andWhere('p.createdAt < :to', { to: new Date(filters.to) });

  const page = await paginateByCreatedAt(filtered, {
    alias: 'p',
    idProperty: 'paymentId',
    limit: filters.limit,
    cursor: filters.cursor,
  });
  const orderIds = [...new Set(page.data.map((payment) => payment.orderId))];
  const orders = new Map(
    (orderIds.length ? await repositories.orders.findBy({ orderId: In(orderIds) }) : []).map((order) => [
      order.orderId,
      order,
    ]),
  );
  return { ...page, data: page.data.map((payment) => ({ payment, order: orders.get(payment.orderId) as Order })) };
};
