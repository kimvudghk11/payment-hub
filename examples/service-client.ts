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

export interface PaymentCancel {
  paymentCancelId: string;
  status: 'REQUESTED' | 'UNKNOWN' | 'DONE' | 'FAILED';
  amount: number;
  reasonCode: string;
  reasonDetail: string | null;
  requestedBy: 'SERVICE' | 'ADMIN' | 'SYSTEM';
  items: { orderItemId: string; quantity: number; amount: number }[];
  failure: { code: string; message: string } | null;
  canceledAt: string | null;
  createdAt: string;
}

/** 결제 단건: 결제 + 취소 이력 */
export interface PaymentDetail extends Payment {
  cancels: PaymentCancel[];
}

/** 결제 수단 (빌링키 원문·customerKey는 없음) */
export interface BillingKey {
  billingKeyId: string;
  externalUserId: string;
  cardCompany: string | null;
  cardNumberMasked: string | null;
  status: 'ACTIVE' | 'REVOKED';
  revokedAt: string | null;
  createdAt: string;
}

/** 웹훅 본문·이벤트 재조회 항목 */
export interface HubEvent {
  eventId: string;
  eventType:
    'PAYMENT_CONFIRMED' | 'PAYMENT_FAILED' | 'PAYMENT_WAITING_FOR_DEPOSIT' | 'PAYMENT_CANCELED' | 'ORDER_EXPIRED';
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface CancelPaymentInput {
  /** 환불 금액. 계산(일할 등)은 서비스가 하고, 상한은 getRefundable().refundableAmount */
  amount: number;
  reasonCode: string;
  /** 토스 취소 사유로 전달 */
  reasonDetail?: string;
  /** 재시도할 때 반드시 같은 값 (예: 서비스 환불 요청 ID) */
  idempotencyKey: string;
  /** 항목별 취소 기록 (선택). 주면 금액 합계 = amount */
  items?: { orderItemId: string; quantity: number; amount: number }[];
  /** 가상계좌 결제만 필수. hub는 저장하지 않는다 */
  refundReceiveAccount?: { bankCode: string; accountNumber: string; holderName: string };
}

/**
 * 결제 승인·환불 요청 타임아웃. hub는 토스 응답을 최대 30초(TOSS_API_TIMEOUT_MS) 기다리므로 그보다 길게 둔다.
 * 그래도 타임아웃이 나면 다시 승인하지 말고 조회로 결과를 확인한다 (환불은 같은 idempotencyKey로 재시도하면 안전).
 */
const PG_CALL_TIMEOUT_MS = 60_000;

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
    return (await this.call<Payment>('POST', '/payments/confirm', input, undefined, PG_CALL_TIMEOUT_MS)).data;
  }

  /** 결제 + 취소 이력 */
  async getPayment(paymentId: string): Promise<PaymentDetail> {
    return (await this.call<PaymentDetail>('GET', `/payments/${paymentId}`)).data;
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

  /**
   * 결제 수단(빌링키) 등록. 토스 카드 등록창 successUrl로 받은 authKey와, 창에 넘긴 customerKey를 보낸다.
   * 빌링키 원문은 hub만 가진다 — 서비스는 billingKeyId로만 자동결제를 요청한다.
   * PG_TIMEOUT이면 등록 여부를 알 수 없으므로 사용자가 카드 등록을 다시 한다 (authKey는 1회용).
   */
  async issueBillingKey(input: { externalUserId: string; customerKey: string; authKey: string }): Promise<BillingKey> {
    return (await this.call<BillingKey>('POST', '/billing-keys', input, undefined, PG_CALL_TIMEOUT_MS)).data;
  }

  /** 사용자의 활성 결제 수단 */
  async listBillingKeys(externalUserId: string): Promise<Page<BillingKey>> {
    return (await this.call<Page<BillingKey>>('GET', '/billing-keys', undefined, { externalUserId })).data;
  }

  /** 결제 수단 해제 (멱등) */
  async revokeBillingKey(billingKeyId: string): Promise<BillingKey> {
    return (await this.call<BillingKey>('DELETE', `/billing-keys/${billingKeyId}`)).data;
  }

  /** 이벤트 재조회: after 이후 이벤트를 발행 순서대로 (웹훅 본문과 같은 형태) */
  async listEvents(query: { after?: string; limit?: number } = {}): Promise<Page<HubEvent>> {
    return (await this.call<Page<HubEvent>>('GET', '/events', undefined, query)).data;
  }

  /**
   * 놓친 웹훅 따라잡기. 마지막으로 처리한 eventId부터 끝까지 읽으며 handle을 호출하고, 마지막 eventId를 돌려준다.
   * 돌려받은 값을 서비스 DB에 저장해 두고 다음 실행 때 넘긴다. handle은 웹훅 처리와 같은 코드(eventId 멱등)를 쓴다.
   */
  async catchUpEvents(
    lastEventId: string | undefined,
    handle: (event: HubEvent) => Promise<void>,
  ): Promise<string | undefined> {
    let after = lastEventId;
    for (;;) {
      const page = await this.listEvents({ after });
      for (const event of page.data) {
        await handle(event);
        after = event.eventId;
      }
      if (!page.nextCursor) return after;
    }
  }

  /**
   * 환불 (전체·부분). 같은 idempotencyKey로 다시 호출하면 기록된 결과를 준다 — 네트워크 오류·타임아웃이면 그대로 재시도.
   * 실패 분기 (PaymentHubError.code):
   *   CANCEL_AMOUNT_EXCEEDED(400)     detail.refundableAmount 이하로 다시 계산
   *   CANCEL_REJECTED(409)            토스 거절 — detail.pgMessage 확인 후 새 idempotencyKey로 다시 요청 가능
   *   PG_TIMEOUT(504) / PG_ERROR(502) 결과 불명 — 같은 idempotencyKey로 재시도하거나 getPayment로 확인
   *   CANCEL_IN_PROGRESS(409)         처리 중 — 잠시 후 getPayment로 확인
   */
  async cancelPayment(
    paymentId: string,
    input: CancelPaymentInput,
  ): Promise<{ cancel: PaymentCancel; payment: Payment }> {
    return (
      await this.call<{ cancel: PaymentCancel; payment: Payment }>(
        'POST',
        `/payments/${paymentId}/cancel`,
        input,
        undefined,
        PG_CALL_TIMEOUT_MS,
      )
    ).data;
  }

  private call<T>(
    method: 'GET' | 'POST' | 'DELETE',
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
