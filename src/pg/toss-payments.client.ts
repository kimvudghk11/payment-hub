import { TossPayment } from './toss-payment.types';

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
   * 결제 조회 (대사). https://docs.tosspayments.com/reference#paymentkey로-결제-조회
   * APPROVED는 "토스가 응답함"이고, 결제 상태(DONE·ABORTED·EXPIRED …)는 payment.status로 판단한다.
   */
  getPayment(params: { secretKey: string; paymentKey: string }): Promise<TossResult> {
    return this.request('GET', `/v1/payments/${encodeURIComponent(params.paymentKey)}`, params.secretKey, {});
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    secretKey: string,
    options: { idempotencyKey?: string; body?: Record<string, unknown> },
  ): Promise<TossResult> {
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

    const json = await readJson(response);
    if (response.status >= 500) return { outcome: 'UNKNOWN', reason: 'SERVER_ERROR', response: json };
    if (!json) return { outcome: 'UNKNOWN', reason: 'INVALID_RESPONSE', response: null };
    if (response.ok) return { outcome: 'APPROVED', payment: json as unknown as TossPayment };

    const code = typeof json.code === 'string' ? json.code : `HTTP_${response.status}`;
    if (ALREADY_PROCESSED_CODES.has(code)) return { outcome: 'UNKNOWN', reason: 'ALREADY_PROCESSED', response: json };
    const message = typeof json.message === 'string' ? json.message : '';
    return { outcome: 'REJECTED', code, message, response: json };
  }
}

const readJson = async (response: Response): Promise<Record<string, unknown> | null> => {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
