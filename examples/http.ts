/**
 * [연동 예제] payment-hub HTTP 호출 공통부. Node.js 18+ 내장 fetch만 사용한다.
 * - 성공 응답 `{ success: true, message, data }`에서 data만 꺼낸다
 * - 실패 응답 `{ success: false, code, message, detail? }`은 PaymentHubError로 던진다 → code로 분기
 */

export class PaymentHubError extends Error {
  constructor(
    /** HTTP status */
    readonly status: number,
    /** 안정적인 에러 코드 (분기에 사용). 예: ORDER_AMOUNT_INVALID */
    readonly code: string,
    /** 사람이 읽는 한국어 메시지 */
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PaymentHubError';
  }
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** 기본 10초. 결제 승인처럼 hub가 PG를 기다리는 요청은 더 길게 준다 */
  timeoutMs?: number;
}

export interface HttpResult<T> {
  status: number;
  data: T;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function callPaymentHub<T>(baseUrl: string, options: RequestOptions): Promise<HttpResult<T>> {
  const url = new URL(`/api/v1${options.path}`, baseUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: options.method,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const payload = (await response.json()) as
    | { success: true; message: string; data: T }
    | { success: false; code: string; message: string; detail?: Record<string, unknown> };

  if (!payload.success) {
    throw new PaymentHubError(response.status, payload.code, payload.message, payload.detail);
  }
  return { status: response.status, data: payload.data };
}

/** 목록 응답 (cursor 페이징) */
export interface Page<T> {
  data: T[];
  totalCount: number;
  nextCursor: string | null;
}
