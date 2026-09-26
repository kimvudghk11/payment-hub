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

export type PaymentStatus =
  | 'IN_PROGRESS'
  | 'UNKNOWN'
  | 'WAITING_FOR_DEPOSIT'
  | 'DONE'
  | 'PARTIAL_CANCELED'
  | 'CANCELED'
  | 'FAILED'
  | 'ABORTED'
  | 'EXPIRED';

export type PaymentMethodType =
  'CARD' | 'VIRTUAL_ACCOUNT' | 'TRANSFER' | 'EASY_PAY' | 'MOBILE_PHONE' | 'GIFT_CERTIFICATE';

export interface Payment {
  paymentId: string;
  orderId: string;
  externalOrderId: string;
  externalUserId: string;
  orderName: string;
  paymentType: 'NORMAL' | 'BILLING';
  status: PaymentStatus;
  amount: number;
  refundedAmount: number;
  refundableAmount: number;
  currency: string;
  /** 해당 수단이 아닌 필드는 null */
  method: {
    type: PaymentMethodType | null;
    raw: string | null;
    cardCompanyCode: string | null;
    cardType: 'CREDIT' | 'CHECK' | 'GIFT' | 'UNKNOWN' | null;
    cardNumberMasked: string | null;
    installmentMonths: number | null;
    easyPayProvider: string | null;
    bankCode: string | null;
    virtualAccountNumber: string | null;
    virtualAccountDueAt: string | null;
  };
  receiptUrl: string | null;
  approvedAt: string | null;
  failure: { code: string; message: string } | null;
  createdAt: string;
}

export interface ListPaymentsQuery {
  externalUserId?: string;
  externalOrderId?: string;
  externalSubscriptionId?: string;
  status?: PaymentStatus[];
  methodType?: PaymentMethodType;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface Refundable {
  paymentId: string;
  status: PaymentStatus;
  amount: number;
  refundedAmount: number;
  /** 환불 요청 amount의 상한 */
  refundableAmount: number;
  items: {
    orderItemId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
    canceledQuantity: number;
    cancelableQuantity: number;
  }[];
}

/**
 * 결제 승인 요청 타임아웃. hub는 토스 응답을 최대 30초(TOSS_API_TIMEOUT_MS) 기다리므로 그보다 길게 둔다.
 * 그래도 타임아웃이 나면 재승인하지 말고 listPayments({ externalOrderId })로 결과를 확인한다.
 */
const CONFIRM_TIMEOUT_MS = 60_000;

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

  /**
   * 결제 승인. 토스 결제창 successUrl로 받은 paymentKey·orderId·amount를 그대로 넘긴다.
   * 같은 paymentKey로 다시 호출하면 hub가 기록된 결과를 준다 (토스를 다시 부르지 않음).
   * 실패 분기 (PaymentHubError.code):
   *   PAYMENT_REJECTED(402)           토스 거절 — detail.pgMessage를 사용자에게 보여주고 다른 수단으로 재시도 유도
   *   PG_TIMEOUT(504) / PG_ERROR(502) 결과 불명 — 재승인하지 말고 조회·웹훅으로 확정을 기다린다
   *   PAYMENT_IN_PROGRESS(409)        이미 처리 중 — 위와 같음
   */
  async confirmPayment(input: { orderId: string; paymentKey: string; amount: number }): Promise<Payment> {
    return (await this.call<Payment>('POST', '/payments/confirm', input, undefined, CONFIRM_TIMEOUT_MS)).data;
  }

  async getPayment(paymentId: string): Promise<Payment> {
    return (await this.call<Payment>('GET', `/payments/${paymentId}`)).data;
  }

  /** 사용자별 결제 이력 등. 실패한 시도도 포함된다 */
  async listPayments(query: ListPaymentsQuery = {}): Promise<Page<Payment>> {
    const { status, ...rest } = query;
    return (await this.call<Page<Payment>>('GET', '/payments', undefined, { ...rest, status: status?.join(',') })).data;
  }

  /** 환불 전에 상한(refundableAmount)과 항목별 취소 가능 수량을 확인한다 */
  async getRefundable(paymentId: string): Promise<Refundable> {
    return (await this.call<Refundable>('GET', `/payments/${paymentId}/refundable`)).data;
  }

  private call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
    timeoutMs?: number,
  ) {
    return callPaymentHub<T>(this.options.baseUrl, {
      method,
      path,
      body,
      query,
      timeoutMs,
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    });
  }
}
