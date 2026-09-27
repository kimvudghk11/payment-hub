import { TossBillingKey, TossPayment } from './toss-payment.types';

export interface TossPaymentsClientOptions {
  /** https://api.tosspayments.com (테스트는 가짜 서버 주소) */
  baseUrl: string;
  timeoutMs: number;
}

export type TossUnknownReason = 'TIMEOUT' | 'NETWORK_ERROR' | 'SERVER_ERROR' | 'ALREADY_PROCESSED' | 'INVALID_RESPONSE';

/**
 * 토스 호출 결과. 예외 대신 결과로 돌려주어 호출하는 쪽이 세 경우를 모두 처리하도록 강제한다.
 * - APPROVED: 토스가 처리함 (상태는 payment.status로 판단 — DONE / WAITING_FOR_DEPOSIT ...)
 * - REJECTED: 토스가 거절함이 확정 (카드 한도 초과 등). 돈이 나가지 않았다
 * - UNKNOWN: 처리됐는지 알 수 없음. 결제를 UNKNOWN으로 두고 대사가 토스 조회로 확정한다
 */
export type TossResult =
  | { outcome: 'APPROVED'; payment: TossPayment }
  | { outcome: 'REJECTED'; code: string; message: string; response: Record<string, unknown> }
  | { outcome: 'UNKNOWN'; reason: TossUnknownReason; response: Record<string, unknown> | null };

/** 빌링키 발급 결과. APPROVED면 빌링키 원문 포함 — 암호화 전까지만 메모리에 둔다 */
export type TossBillingKeyResult =
  { outcome: 'APPROVED'; billingKey: TossBillingKey } | Exclude<TossResult, { outcome: 'APPROVED' }>;

/** 빌링키 삭제 결과. DELETED = 토스에 그 빌링키가 더 이상 없음 (이미 없던 경우 포함) */
export type TossDeleteResult = { outcome: 'DELETED' } | Exclude<TossResult, { outcome: 'APPROVED' }>;

/** 이전 요청이 이미 승인했을 수 있는 코드 — 실패로 확정하면 "돈은 나갔는데 실패 기록"이 된다 */
const ALREADY_PROCESSED_CODES = new Set(['ALREADY_PROCESSED_PAYMENT', 'ALREADY_CANCELED_PAYMENT']);

/**
 * 토스페이먼츠 API 클라이언트. 시크릿 키는 호출마다 받는다 (서비스별 자격증명).
 * 시크릿 키·요청 본문은 로그에 남기지 않는다.
 */
export class TossPaymentsClient {
  constructor(private readonly options: TossPaymentsClientOptions) {}

  /** 결제 승인 (결제창 인증 후). https://docs.tosspayments.com/reference#결제-승인 */
  confirm(params: {
    secretKey: string;
    paymentKey: string;
    orderId: string;
    amount: number;
    idempotencyKey: string;
  }): Promise<TossResult> {
    return this.request('POST', '/v1/payments/confirm', params.secretKey, {
      idempotencyKey: params.idempotencyKey,
      body: { paymentKey: params.paymentKey, orderId: params.orderId, amount: params.amount },
    });
  }

  /**
   * 결제 취소(전체·부분). https://docs.tosspayments.com/reference#결제-취소
   * 가상계좌 환불 계좌는 토스에 전달만 하고 hub는 저장하지 않는다.
   */
  cancel(params: {
    secretKey: string;
    paymentKey: string;
    cancelReason: string;
    cancelAmount: number;
    idempotencyKey: string;
    refundReceiveAccount?: { bankCode: string; accountNumber: string; holderName: string };
  }): Promise<TossResult> {
    const account = params.refundReceiveAccount;
    return this.request('POST', `/v1/payments/${encodeURIComponent(params.paymentKey)}/cancel`, params.secretKey, {
      idempotencyKey: params.idempotencyKey,
      body: {
        cancelReason: params.cancelReason,
        cancelAmount: params.cancelAmount,
        ...(account
          ? {
              refundReceiveAccount: {
                bank: account.bankCode,
                accountNumber: account.accountNumber,
                holderName: account.holderName,
              },
            }
          : {}),
      },
    });
  }

  /**
   * 빌링키 발급 (카드 등록창 인증 후). https://docs.tosspayments.com/reference#authkey로-빌링키-발급
   * 응답의 billingKey는 시크릿 키와 합쳐지면 결제가 가능한 값 — 호출하는 쪽이 바로 암호화하고 로그에 남기지 않는다.
   */
  async issueBillingKey(params: {
    secretKey: string;
    authKey: string;
    customerKey: string;
  }): Promise<TossBillingKeyResult> {
    const result = await this.request('POST', '/v1/billing/authorizations/issue', params.secretKey, {
      body: { authKey: params.authKey, customerKey: params.customerKey },
    });
    return result.outcome === 'APPROVED'
      ? { outcome: 'APPROVED', billingKey: result.payment as unknown as TossBillingKey }
      : result;
  }

  /** 빌링키로 자동결제 승인. https://docs.tosspayments.com/reference#카드-자동결제-승인 */
  chargeBilling(params: {
    secretKey: string;
    billingKey: string;
    customerKey: string;
    amount: number;
    orderId: string;
    orderName: string;
    idempotencyKey: string;
  }): Promise<TossResult> {
    return this.request('POST', `/v1/billing/${encodeURIComponent(params.billingKey)}`, params.secretKey, {
      idempotencyKey: params.idempotencyKey,
      body: {
        customerKey: params.customerKey,
        amount: params.amount,
        orderId: params.orderId,
        orderName: params.orderName,
      },
    });
  }

  /** 주문번호로 결제 조회 — paymentKey를 받기 전에 결과를 모르게 된 자동결제의 대사용 */
  getPaymentByOrderId(params: { secretKey: string; orderId: string }): Promise<TossResult> {
    return this.request('GET', `/v1/payments/orders/${encodeURIComponent(params.orderId)}`, params.secretKey, {});
  }

  /**
   * 결제 조회 (대사). https://docs.tosspayments.com/reference#paymentkey로-결제-조회
   * APPROVED는 "토스가 응답함"이고, 결제 상태(DONE·ABORTED·EXPIRED …)는 payment.status로 판단한다.
   */
  getPayment(params: { secretKey: string; paymentKey: string }): Promise<TossResult> {
    return this.request('GET', `/v1/payments/${encodeURIComponent(params.paymentKey)}`, params.secretKey, {});
  }

  /**
   * 빌링키 삭제 (hub에서 해제한 뒤 토스에서도 지운다). https://docs.tosspayments.com/reference#빌링키-삭제
   * 404는 이미 지워졌거나 없는 키 — 삭제의 목적이 달성된 상태이므로 DELETED로 본다.
   */
  async deleteBillingKey(params: { secretKey: string; billingKey: string }): Promise<TossDeleteResult> {
    const sent = await this.send(
      'DELETE',
      `/v1/billing/${encodeURIComponent(params.billingKey)}`,
      params.secretKey,
      {},
    );
    if ('outcome' in sent) return sent;
    const { status, json } = sent;
    if (status >= 500) return { outcome: 'UNKNOWN', reason: 'SERVER_ERROR', response: json };
    if ((status >= 200 && status < 300) || status === 404) return { outcome: 'DELETED' };
    return rejected(status, json ?? {});
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    secretKey: string,
    options: { idempotencyKey?: string; body?: Record<string, unknown> },
  ): Promise<TossResult> {
    const sent = await this.send(method, path, secretKey, options);
    if ('outcome' in sent) return sent;
    const { status, json } = sent;
    if (status >= 500) return { outcome: 'UNKNOWN', reason: 'SERVER_ERROR', response: json };
    if (!json) return { outcome: 'UNKNOWN', reason: 'INVALID_RESPONSE', response: null };
    if (status >= 200 && status < 300) return { outcome: 'APPROVED', payment: json as unknown as TossPayment };

    const result = rejected(status, json);
    if (ALREADY_PROCESSED_CODES.has(result.code))
      return { outcome: 'UNKNOWN', reason: 'ALREADY_PROCESSED', response: json };
    return result;
  }

  /** HTTP 호출. 응답을 받으면 status·본문을, 받지 못하면(타임아웃·연결 실패) UNKNOWN을 돌려준다 */
  private async send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    secretKey: string,
    options: { idempotencyKey?: string; body?: Record<string, unknown> },
  ): Promise<{ status: number; json: Record<string, unknown> | null } | Extract<TossResult, { outcome: 'UNKNOWN' }>> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.options.baseUrl), {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      // 요청이 토스에 도달했는지 알 수 없으므로 연결 실패도 UNKNOWN
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      return { outcome: 'UNKNOWN', reason: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', response: null };
    }
    return { status: response.status, json: await readJson(response) };
  }
}

const rejected = (status: number, json: Record<string, unknown>): Extract<TossResult, { outcome: 'REJECTED' }> => ({
  outcome: 'REJECTED',
  code: typeof json.code === 'string' ? json.code : `HTTP_${status}`,
  message: typeof json.message === 'string' ? json.message : '',
  response: json,
});

const readJson = async (response: Response): Promise<Record<string, unknown> | null> => {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
