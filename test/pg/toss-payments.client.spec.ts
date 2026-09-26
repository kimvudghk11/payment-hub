import { TossPaymentsClient } from '../../src/pg/toss-payments.client';
import { FakeToss } from '../support/fake-toss';

const SECRET_KEY = 'test_sk_fake_1234';
const confirmParams = {
  secretKey: SECRET_KEY,
  paymentKey: 'tgen_abc',
  orderId: '3f1a0000-0000-4000-8000-000000000001',
  amount: 30000,
  idempotencyKey: 'confirm:abc',
};

describe('TossPaymentsClient.confirm', () => {
  const toss = new FakeToss();
  let client: TossPaymentsClient;

  beforeAll(async () => {
    client = new TossPaymentsClient({ baseUrl: await toss.start(), timeoutMs: 300 });
  });
  afterEach(() => toss.reset());
  afterAll(() => toss.close());

  it('토스 승인 API 규격대로 호출한다 — Basic 인증(시크릿 키 + ":"), Idempotency-Key, 본문', async () => {
    await client.confirm(confirmParams);

    const [request] = toss.requests;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/payments/confirm');
    expect(request.headers.authorization).toBe(`Basic ${Buffer.from(`${SECRET_KEY}:`).toString('base64')}`);
    expect(request.headers['idempotency-key']).toBe('confirm:abc');
    expect(request.body).toEqual({ paymentKey: 'tgen_abc', orderId: confirmParams.orderId, amount: 30000 });
  });

  it('2xx → APPROVED + 토스 Payment 객체', async () => {
    const result = await client.confirm(confirmParams);

    expect(result.outcome).toBe('APPROVED');
    if (result.outcome !== 'APPROVED') return;
    expect(result.payment).toMatchObject({ paymentKey: 'tgen_abc', status: 'DONE', method: '카드' });
  });

  it('4xx → REJECTED + 토스 원본 코드·메시지 (확정 실패)', async () => {
    const body = { code: 'REJECT_CARD_PAYMENT', message: '한도초과 혹은 잔액부족으로 결제에 실패했습니다.' };
    toss.respond(() => ({ status: 403, body }));

    await expect(client.confirm(confirmParams)).resolves.toEqual({
      outcome: 'REJECTED',
      code: 'REJECT_CARD_PAYMENT',
      message: body.message,
      response: body,
    });
  });

  it('ALREADY_PROCESSED_PAYMENT는 이전 승인이 이미 됐을 수 있으므로 UNKNOWN (대사가 조회로 확정)', async () => {
    const body = { code: 'ALREADY_PROCESSED_PAYMENT', message: '이미 처리된 결제 입니다.' };
    toss.respond(() => ({ status: 400, body }));

    await expect(client.confirm(confirmParams)).resolves.toMatchObject({
      outcome: 'UNKNOWN',
      reason: 'ALREADY_PROCESSED',
      response: body,
    });
  });

  it('5xx → UNKNOWN (토스 내부에서 처리됐는지 알 수 없음)', async () => {
    toss.respond(() => ({ status: 500, body: { code: 'FAILED_INTERNAL_SYSTEM_PROCESSING', message: '내부 오류' } }));

    await expect(client.confirm(confirmParams)).resolves.toMatchObject({ outcome: 'UNKNOWN', reason: 'SERVER_ERROR' });
  });

  it('응답이 타임아웃을 넘기면 UNKNOWN(TIMEOUT)', async () => {
    toss.respond((request) => ({ status: 200, body: { paymentKey: request.body.paymentKey }, delayMs: 1000 }));

    await expect(client.confirm(confirmParams)).resolves.toEqual({
      outcome: 'UNKNOWN',
      reason: 'TIMEOUT',
      response: null,
    });
  });

  it('2xx인데 본문이 JSON이 아니면 UNKNOWN(INVALID_RESPONSE)', async () => {
    toss.respond(() => ({ status: 200, body: '<html>proxy error</html>' }));

    await expect(client.confirm(confirmParams)).resolves.toMatchObject({
      outcome: 'UNKNOWN',
      reason: 'INVALID_RESPONSE',
    });
  });

  it('연결 자체가 실패해도 요청이 도달했는지 알 수 없으므로 UNKNOWN(NETWORK_ERROR)', async () => {
    const unreachable = new TossPaymentsClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 });

    await expect(unreachable.confirm(confirmParams)).resolves.toEqual({
      outcome: 'UNKNOWN',
      reason: 'NETWORK_ERROR',
      response: null,
    });
  });
});
