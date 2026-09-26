import { buildWebhookHeaders } from './webhook-signature';

export type WebhookSendResult =
  { ok: true; httpStatus: number } | { ok: false; httpStatus: number | null; error: string };

/**
 * 웹훅 HTTP 전송 한 번. 2xx만 성공으로 본다.
 * 리다이렉트는 따라가지 않는다 (등록된 URL 외의 곳으로 결제 이벤트를 보내지 않음). 응답 본문은 읽지 않는다.
 */
export class WebhookSender {
  constructor(readonly timeoutMs: number) {}

  async send(params: { url: string; secret: string; eventId: string; rawBody: string }): Promise<WebhookSendResult> {
    try {
      const response = await fetch(params.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'payment-hub-webhook/1',
          ...buildWebhookHeaders({
            secret: params.secret,
            eventId: params.eventId,
            rawBody: params.rawBody,
            now: new Date(),
          }),
        },
        body: params.rawBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await response.body?.cancel();
      if (response.ok) return { ok: true, httpStatus: response.status };
      return { ok: false, httpStatus: response.status, error: `HTTP ${response.status}` };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return { ok: false, httpStatus: null, error: `응답 시간 초과 (${this.timeoutMs}ms)` };
      }
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      return { ok: false, httpStatus: null, error: cause ? `연결 실패 (${cause})` : '연결 실패' };
    }
  }
}
