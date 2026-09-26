/**
 * [연동 예제] 서비스 서버에서 payment-hub 웹훅을 검증한다.
 * Node.js 내장 crypto만 사용하므로 그대로 복사해 쓸 수 있다.
 * 이 파일은 hub의 실제 서명 함수와 맞는지 test/docs/webhook-signature.spec.ts가 검증한다.
 *
 * 주의: rawBody는 JSON 파싱 전의 원문 문자열이어야 한다 (파싱 후 다시 직렬화하면 서명이 달라질 수 있음).
 */
import { createHmac, timingSafeEqual } from 'crypto';

const TOLERANCE_SECONDS = 300;

export type WebhookVerifyResult =
  { ok: true; eventId: string } | { ok: false; reason: 'MISSING_HEADER' | 'STALE_TIMESTAMP' | 'INVALID_SIGNATURE' };

export function verifyPaymentHubWebhook(params: {
  /** admin이 서비스 등록·서명 키 교체 시 1회 전달한 whsec_… 값 */
  secret: string;
  /** 요청 본문 원문 */
  rawBody: string;
  /** 요청 헤더 (대소문자 무관) */
  headers: Record<string, string | string[] | undefined>;
  /** 현재 시각 (ms). 테스트용 */
  now?: number;
}): WebhookVerifyResult {
  const header = (name: string): string | undefined => {
    const entry = Object.entries(params.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
    const value = entry?.[1];
    return Array.isArray(value) ? value[0] : value;
  };

  const eventId = header('X-PaymentHub-Event-Id');
  const timestamp = header('X-PaymentHub-Timestamp');
  const signature = header('X-PaymentHub-Signature');
  if (!eventId || !timestamp || !signature) return { ok: false, reason: 'MISSING_HEADER' };

  // 1. 5분보다 오래됐거나 미래인 요청은 재전송 공격일 수 있으므로 거부
  const nowSeconds = Math.floor((params.now ?? Date.now()) / 1000);
  if (!/^\d+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'STALE_TIMESTAMP' };
  }

  // 2. 서명 비교는 타이밍 공격을 막기 위해 timingSafeEqual
  const expected = `v1=${createHmac('sha256', params.secret).update(`${timestamp}.${params.rawBody}`).digest('hex')}`;
  const valid = expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  if (!valid) return { ok: false, reason: 'INVALID_SIGNATURE' };

  // 3. 통과 후에는 eventId로 이미 처리한 이벤트인지 확인한다 (같은 이벤트가 여러 번 올 수 있음)
  return { ok: true, eventId };
}
