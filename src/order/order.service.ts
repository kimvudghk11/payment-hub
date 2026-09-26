import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { paginateByCreatedAt } from '../common/database/cursor-pagination';
import { isUniqueViolation } from '../common/database/unique-violation';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-code';
import { IPageable } from '../common/interceptors/response.interceptor';
import { ServiceProductType } from '../service/domain/service-product-type.entity';
import { OrderItem } from './domain/order-item.entity';
import { CreateOrderParams, Order } from './domain/order.entity';
import { ListOrdersQueryDto } from './dto/request/list-orders.query.dto';

/** 서비스 API 주문 유스케이스. 모든 조회·쓰기는 인증된 serviceId로 범위를 고정한다 */
@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(OrderItem) private readonly orderItems: Repository<OrderItem>,
    @InjectRepository(ServiceProductType) private readonly productTypes: Repository<ServiceProductType>,
  ) {}

  /**
   * 주문 등록 (멱등). 같은 (서비스, externalOrderId)가 있으면 내용을 비교해
   * 같으면 기존 주문(created=false), 다르면 409 ORDER_IDEMPOTENCY_CONFLICT.
   */
  async create(params: CreateOrderParams): Promise<{ order: Order; created: boolean }> {
    const existing = await this.findByExternalOrderId(params.serviceId, params.externalOrderId);
    if (existing) return { order: this.replay(existing, params), created: false };

    try {
      return { order: await this.insert(params), created: true };
    } catch (error) {
      // 동시에 같은 주문이 등록된 경우: 실패한 트랜잭션 밖에서 다시 읽어 멱등 응답
      if (!isUniqueViolation(error, 'uq_tb_order_external')) throw error;
      const winner = await this.findByExternalOrderId(params.serviceId, params.externalOrderId);
      if (!winner) throw error;
      return { order: this.replay(winner, params), created: false };
    }
  }

  async get(serviceId: string, orderId: string): Promise<Order> {
    const order = await this.orders.findOne({
      where: { orderId, serviceId },
      relations: { items: true },
    });
    if (!order) throw new BusinessException(ErrorCode.ORDER_NOT_FOUND);
    return order;
  }

  async list(serviceId: string, query: ListOrdersQueryDto): Promise<IPageable<Order>> {
    const filtered = this.orders.createQueryBuilder('o').where('o.serviceId = :serviceId', { serviceId });
    if (query.externalOrderId) filtered.andWhere('o.externalOrderId = :eo', { eo: query.externalOrderId });
    if (query.externalUserId) filtered.andWhere('o.externalUserId = :eu', { eu: query.externalUserId });
    if (query.externalSubscriptionId) {
      filtered.andWhere('o.externalSubscriptionId = :es', { es: query.externalSubscriptionId });
    }
    if (query.status) filtered.andWhere('o.status = :status', { status: query.status });
    if (query.from) filtered.andWhere('o.createdAt >= :from', { from: new Date(query.from) });
    if (query.to) filtered.andWhere('o.createdAt < :to', { to: new Date(query.to) });

    return paginateByCreatedAt(filtered, {
      alias: 'o',
      idProperty: 'orderId',
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  @Transactional()
  private async insert(params: CreateOrderParams): Promise<Order> {
    await this.assertProductTypesAllowed(
      params.serviceId,
      params.items.map((item) => item.productType),
    );

    const order = Order.create(params);
    // 관계에 cascade를 두지 않았으므로 주문 → 항목 순서로 명시적으로 저장한다
    await this.orders.save(order);
    await this.orderItems.save(order.items);
    return this.get(params.serviceId, order.orderId);
  }

  private replay(existing: Order, params: CreateOrderParams): Order {
    if (!existing.matches(params)) throw new BusinessException(ErrorCode.ORDER_IDEMPOTENCY_CONFLICT);
    return existing;
  }

  private findByExternalOrderId(serviceId: string, externalOrderId: string): Promise<Order | null> {
    return this.orders.findOne({ where: { serviceId, externalOrderId }, relations: { items: true } });
  }

  /** DB FK는 존재만 강제한다. 활성 여부는 앱이 확인한다 */
  private async assertProductTypesAllowed(serviceId: string, codes: string[]): Promise<void> {
    const requested = [...new Set(codes)];
    const allowed = await this.productTypes.find({ where: { serviceId, code: In(requested), isActive: true } });
    const allowedCodes = new Set(allowed.map((productType) => productType.code));
    const notAllowed = requested.filter((code) => !allowedCodes.has(code)).sort();
    if (notAllowed.length > 0) {
      throw new BusinessException(ErrorCode.PRODUCT_TYPE_NOT_ALLOWED, { productTypes: notAllowed });
    }
  }
}
