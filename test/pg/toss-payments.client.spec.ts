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

describe('TossPaymentsClient.getPayment (대사용 조회)', () => {
  const toss = new FakeToss();
  let client: TossPaymentsClient;

  beforeAll(async () => {
    client = new TossPaymentsClient({ baseUrl: await toss.start(), timeoutMs: 300 });
  });
  afterEach(() => toss.reset());
  afterAll(() => toss.close());

  it('GET /v1/payments/{paymentKey} — Basic 인증, paymentKey는 URL 인코딩', async () => {
    toss.respond(() => ({ status: 200, body: { paymentKey: 'tgen a/b', status: 'DONE' } }));
    await client.getPayment({ secretKey: SECRET_KEY, paymentKey: 'tgen a/b' });

    const [request] = toss.requests;
    expect(request.method).toBe('GET');
    expect(request.path).toBe('/v1/payments/tgen%20a%2Fb');
    expect(request.headers.authorization).toBe(`Basic ${Buffer.from(`${SECRET_KEY}:`).toString('base64')}`);
  });

  it('200 → APPROVED + 토스가 아는 현재 상태 (DONE·ABORTED·EXPIRED …)', async () => {
    toss.respond(() => ({ status: 200, body: { paymentKey: 'tgen_abc', status: 'ABORTED' } }));

    await expect(client.getPayment({ secretKey: SECRET_KEY, paymentKey: 'tgen_abc' })).resolves.toMatchObject({
      outcome: 'APPROVED',
      payment: { status: 'ABORTED' },
    });
  });

  it('404 → REJECTED(NOT_FOUND_PAYMENT)', async () => {
    toss.respond(() => ({
      status: 404,
      body: { code: 'NOT_FOUND_PAYMENT', message: '존재하지 않는 결제 정보 입니다.' },
    }));

    await expect(client.getPayment({ secretKey: SECRET_KEY, paymentKey: 'tgen_abc' })).resolves.toMatchObject({
      outcome: 'REJECTED',
      code: 'NOT_FOUND_PAYMENT',
    });
  });

  it('타임아웃 → UNKNOWN(TIMEOUT)', async () => {
    toss.respond(() => ({ status: 200, body: {}, delayMs: 1000 }));

    await expect(client.getPayment({ secretKey: SECRET_KEY, paymentKey: 'tgen_abc' })).resolves.toMatchObject({
      outcome: 'UNKNOWN',
      reason: 'TIMEOUT',
    });
  });
});

describe('TossPaymentsClient.cancel (환불)', () => {
  const toss = new FakeToss();
  let client: TossPaymentsClient;
  const cancelParams = {
    secretKey: SECRET_KEY,
    paymentKey: 'tgen_abc',
    cancelReason: '저장공간 1개 환불',
    cancelAmount: 3000,
    idempotencyKey: 'cancel:abc',
  };

  beforeAll(async () => {
    client = new TossPaymentsClient({ baseUrl: await toss.start(), timeoutMs: 300 });
  });
  afterEach(() => toss.reset());
  afterAll(() => toss.close());

  it('POST /v1/payments/{paymentKey}/cancel — 취소 사유·금액, Idempotency-Key', async () => {
    toss.respond(() => ({ status: 200, body: { paymentKey: 'tgen_abc', status: 'PARTIAL_CANCELED', cancels: [] } }));
    await client.cancel(cancelParams);

    const [request] = toss.requests;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/payments/tgen_abc/cancel');
    expect(request.headers['idempotency-key']).toBe('cancel:abc');
    expect(request.body).toEqual({ cancelReason: '저장공간 1개 환불', cancelAmount: 3000 });
  });

  it('가상계좌 환불 계좌는 토스 형식(bank, accountNumber, holderName)으로 전달만 한다', async () => {
    toss.respond(() => ({ status: 200, body: { paymentKey: 'tgen_abc', status: 'CANCELED', cancels: [] } }));
    await client.cancel({
      ...cancelParams,
      refundReceiveAccount: { bankCode: '20', accountNumber: '1002123', holderName: '홍길동' },
    });

    expect(toss.requests[0].body.refundReceiveAccount).toEqual({
      bank: '20',
      accountNumber: '1002123',
      holderName: '홍길동',
    });
  });

  it('4xx → REJECTED (취소 불가 금액 등)', async () => {
    toss.respond(() => ({
      status: 403,
      body: { code: 'NOT_CANCELABLE_AMOUNT', message: '취소 할 수 없는 금액 입니다.' },
    }));

    await expect(client.cancel(cancelParams)).resolves.toMatchObject({
      outcome: 'REJECTED',
      code: 'NOT_CANCELABLE_AMOUNT',
    });
  });

  it('ALREADY_CANCELED_PAYMENT는 이전 요청으로 이미 취소됐을 수 있으므로 UNKNOWN', async () => {
    toss.respond(() => ({
      status: 400,
      body: { code: 'ALREADY_CANCELED_PAYMENT', message: '이미 취소된 결제 입니다.' },
    }));

    await expect(client.cancel(cancelParams)).resolves.toMatchObject({
      outcome: 'UNKNOWN',
      reason: 'ALREADY_PROCESSED',
    });
  });
});
