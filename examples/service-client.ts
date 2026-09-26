/**
 * [연동 예제] 서비스 서버 → payment-hub 클라이언트.
 * 서비스 API 키(ph_test_… / ph_live_…)는 서버 환경변수에만 두고 프론트엔드에 노출하지 않는다.
 * 이 파일은 test/docs/example-clients.int-spec.ts가 실제 hub에 붙여 검증한다.
 */
import { callPaymentHub, Page } from './http';

export interface ServiceIdentity {
  serviceId: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
}

export interface PgClientConfig {
  provider: 'TOSS';
  environment: 'TEST' | 'LIVE';
  clientKey: string;
}

export interface CreateOrderInput {
  /** 서비스 쪽 주문번호. 재시도할 때 반드시 같은 값을 보낸다 (멱등키) */
  externalOrderId: string;
  externalUserId: string;
  externalSubscriptionId?: string;
  orderName: string;
  currency?: string;
  items: {
    productType: string;
    externalProductId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
  }[];
  discountType?: string;
  discountAmount?: number;
  /** = sum(unitPrice × quantity) − discountAmount */
  totalAmount: number;
  expiresInSeconds?: number;
  metadata?: Record<string, unknown>;
}

export type OrderStatus = 'PENDING' | 'PAID' | 'PARTIAL_CANCELED' | 'CANCELED' | 'EXPIRED';

export interface OrderSummary {
  orderId: string;
  externalOrderId: string;
  externalUserId: string;
  externalSubscriptionId: string | null;
  orderName: string;
  currency: string;
  originalAmount: number;
  discountType: string | null;
  discountAmount: number;
  totalAmount: number;
  status: OrderStatus;
  expiresAt: string;
  paidAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Order extends OrderSummary {
  items: {
    orderItemId: string;
    lineNo: number;
    productType: string;
    externalProductId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
    amount: number;
    canceledQuantity: number;
  }[];
}

export interface ListOrdersQuery {
  externalOrderId?: string;
  externalUserId?: string;
  externalSubscriptionId?: string;
  status?: OrderStatus;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export class PaymentHubServiceClient {
  constructor(private readonly options: { baseUrl: string; apiKey: string }) {}

  /** 키가 어느 서비스로 인증되는지 확인. 배포 직후 헬스체크로 쓰기 좋다 */
  async me(): Promise<ServiceIdentity> {
    return (await this.call<ServiceIdentity>('GET', '/me')).data;
  }

  /** 결제창을 띄울 때 프론트에 내려줄 공개 clientKey */
  async getPgClientConfig(): Promise<PgClientConfig> {
    return (await this.call<PgClientConfig>('GET', '/pg/client-config')).data;
  }

  /**
   * 주문 등록. created=false면 같은 externalOrderId로 이미 등록된 주문(재시도)이다.
   * 네트워크 오류·타임아웃이면 같은 입력으로 다시 호출하면 된다.
   */
  async createOrder(input: CreateOrderInput): Promise<{ order: Order; created: boolean }> {
    const { status, data } = await this.call<Order>('POST', '/orders', input);
    return { order: data, created: status === 201 };
  }

  async getOrder(orderId: string): Promise<Order> {
    return (await this.call<Order>('GET', `/orders/${orderId}`)).data;
  }

  async listOrders(query: ListOrdersQuery = {}): Promise<Page<OrderSummary>> {
    return (await this.call<Page<OrderSummary>>('GET', '/orders', undefined, { ...query })).data;
  }

  private call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ) {
    return callPaymentHub<T>(this.options.baseUrl, {
      method,
      path,
      body,
      query,
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    });
  }
}
