import { createHmac } from 'crypto';

/**
 * hub → 서비스 웹훅 서명 규격 (docs/api.md 4장).
 *   X-PaymentHub-Signature: v1=<hex(HMAC-SHA256(webhookSecret, "<timestamp>.<rawBody>"))>
 * 타임스탬프를 서명에 포함해 서비스가 오래된 요청의 재전송을 거부할 수 있게 한다.
 * 서비스 쪽 검증 예제: examples/webhook-signature-verify.ts (서로 맞는지 test/docs에서 검증)
 */
export const WEBHOOK_HEADERS = {
  EVENT_ID: 'X-PaymentHub-Event-Id',
  TIMESTAMP: 'X-PaymentHub-Timestamp',
  SIGNATURE: 'X-PaymentHub-Signature',
} as const;

export const signWebhookPayload = (secret: string, timestamp: number, rawBody: string): string =>
  `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;

export const buildWebhookHeaders = (params: {
  secret: string;
  eventId: string;
  rawBody: string;
  now: Date;
}): Record<string, string> => {
  const timestamp = Math.floor(params.now.getTime() / 1000);
  return {
    [WEBHOOK_HEADERS.EVENT_ID]: params.eventId,
    [WEBHOOK_HEADERS.TIMESTAMP]: String(timestamp),
    [WEBHOOK_HEADERS.SIGNATURE]: signWebhookPayload(params.secret, timestamp, params.rawBody),
  };
};
