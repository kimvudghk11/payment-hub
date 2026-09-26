import { verifyPaymentHubWebhook } from '../../examples/webhook-signature-verify';
import { buildWebhookHeaders } from '../../src/outbox/webhook-signature';

/**
 * hub가 보내는 서명(src/outbox)과 서비스용 검증 예제(examples/)가 서로 맞는지 검증한다.
 * 연동 가이드는 이 예제를 그대로 싣는다 → 가이드의 코드가 틀릴 수 없다.
 */
describe('웹훅 서명 규격 (hub 서명 ↔ 서비스 검증 예제)', () => {
  const secret = 'whsec_test_secret_value';
  const body = JSON.stringify({ eventId: 'evt-1', eventType: 'PAYMENT_CONFIRMED', data: { amount: 30000 } });
  const now = new Date('2026-09-27T01:00:00.000Z');

  const signed = () => buildWebhookHeaders({ secret, eventId: 'evt-1', rawBody: body, now });
  const verify = (overrides: Partial<Parameters<typeof verifyPaymentHubWebhook>[0]> = {}) =>
    verifyPaymentHubWebhook({ secret, rawBody: body, headers: signed(), now: now.getTime(), ...overrides });

  it('hub가 서명한 요청은 예제 검증을 통과한다', () => {
    expect(verify()).toEqual({ ok: true, eventId: 'evt-1' });
  });

  it('헤더는 X-PaymentHub-Event-Id / Timestamp(Unix 초) / Signature(v1=hex)', () => {
    expect(signed()).toEqual({
      'X-PaymentHub-Event-Id': 'evt-1',
      'X-PaymentHub-Timestamp': String(now.getTime() / 1000),
      'X-PaymentHub-Signature': expect.stringMatching(/^v1=[0-9a-f]{64}$/) as unknown,
    });
  });

  it('Express처럼 헤더 이름이 소문자여도 검증한다', () => {
    const lowerCased = Object.fromEntries(Object.entries(signed()).map(([k, v]) => [k.toLowerCase(), v]));

    expect(verify({ headers: lowerCased }).ok).toBe(true);
  });

  it('본문이 한 글자라도 바뀌면 INVALID_SIGNATURE', () => {
    expect(verify({ rawBody: body.replace('30000', '30001') })).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('다른 서명 키면 INVALID_SIGNATURE', () => {
    expect(verify({ secret: 'whsec_other' })).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('타임스탬프가 5분보다 오래됐거나 미래면 STALE_TIMESTAMP (재전송 공격 방지)', () => {
    expect(verify({ now: now.getTime() + 301_000 })).toEqual({ ok: false, reason: 'STALE_TIMESTAMP' });
    expect(verify({ now: now.getTime() - 301_000 })).toEqual({ ok: false, reason: 'STALE_TIMESTAMP' });
    expect(verify({ now: now.getTime() + 299_000 }).ok).toBe(true);
  });

  it('필수 헤더가 없으면 MISSING_HEADER', () => {
    const withoutSignature = Object.fromEntries(
      Object.entries(signed()).filter(([name]) => name !== 'X-PaymentHub-Signature'),
    );

    expect(verify({ headers: withoutSignature })).toEqual({ ok: false, reason: 'MISSING_HEADER' });
  });
});
