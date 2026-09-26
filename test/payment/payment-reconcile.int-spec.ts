import { PaymentReconciler } from '../../src/payment/payment-reconciler';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss, FakeTossResponse, approvedCardPayment } from '../support/fake-toss';
import { IntegrationApp, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

const MINUTE = 60_000;
let seq = 0;

describe('대사 배치 — 결과 불명·멈춘 결제를 토스 조회로 확정', () => {
  const toss = new FakeToss();
  /** paymentKey별 토스 조회 응답. 없으면 "아직 승인 전(IN_PROGRESS)" */
  const tossState = new Map<string, (paymentKey: string) => FakeTossResponse>();
  let ctx: IntegrationApp;
  let reconciler: PaymentReconciler;
  let service: PayableService;

  const later = () => new Date(Date.now() + 3 * MINUTE);
  const auth = () => ({ Authorization: `Bearer ${service.apiKey}` });

  const createOrder = async (): Promise<string> => {
    const res = await ctx
      .http()
      .post('/api/v1/orders')
      .set(auth())
      .send({
        externalOrderId: `rc-order-${Date.now()}-${seq++}`,
        externalUserId: 'user-1',
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 30000, quantity: 1 }],
        totalAmount: 30000,
      });
    return dataOf<{ orderId: string }>(res).orderId;
  };
  const confirm = (orderId: string, paymentKey: string) =>
    ctx.http().post('/api/v1/payments/confirm').set(auth()).send({ orderId, paymentKey, amount: 30000 });

  /** 승인 응답이 늦어 UNKNOWN으로 남은 결제 */
  const unknownPayment = async () => {
    const orderId = await createOrder();
    const paymentKey = `tgen_rc_${seq++}`;
    const res = await confirm(orderId, paymentKey);
    expect(errorOf(res).code).toBe('PG_TIMEOUT');
    return { orderId, paymentKey, paymentId: errorOf(res).detail?.paymentId as string };
  };

  const tossPaymentFor = (orderId: string, paymentKey: string, overrides: Record<string, unknown>) =>
    approvedCardPayment(
      { method: 'GET', path: '', headers: {}, body: { orderId, paymentKey, amount: 30000 } },
      overrides,
    );

  const paymentRow = async (paymentId: string) =>
    (
      await ctx.dataSource.query<{ status: string; failure_code: string | null; updated_at: Date }[]>(
        'SELECT status, failure_code, updated_at FROM tb_payment WHERE id = $1',
        [paymentId],
      )
    )[0];
  const orderStatus = async (orderId: string) =>
    (await ctx.dataSource.query<{ status: string }[]>('SELECT status FROM tb_order WHERE id = $1', [orderId]))[0]
      .status;
  const eventTypes = async (paymentId: string) =>
    (
      await ctx.dataSource.query<{ event_type: string }[]>(
        'SELECT event_type FROM tb_outbox_event WHERE aggregate_id = $1',
        [paymentId],
      )
    ).map((row) => row.event_type);
  const tossLookupsOf = (paymentKey: string) =>
    toss.requests.filter((request) => request.method === 'GET' && request.path.endsWith(`/${paymentKey}`));

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), TOSS_API_TIMEOUT_MS: '300' });
    reconciler = ctx.app.get(PaymentReconciler);
    service = await onboardPayableService(ctx);
  });
  beforeEach(() => {
    // 승인(POST)은 늦게 응답해 UNKNOWN을 만들고, 조회(GET)는 tossState대로 응답한다
    toss.respond((request) => {
      if (request.method === 'POST') return { status: 200, body: approvedCardPayment(request), delayMs: 1000 };
      const paymentKey = decodeURIComponent(request.path.split('/').pop() ?? '');
      const state = tossState.get(paymentKey);
      return state ? state(paymentKey) : { status: 200, body: { paymentKey, status: 'IN_PROGRESS' } };
    });
  });
  afterEach(() => {
    toss.reset();
    tossState.clear();
  });
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  it('토스가 승인(DONE)했으면 DONE으로 확정 — 주문 PAID, 원장 기장, PAYMENT_CONFIRMED 이벤트', async () => {
    const { orderId, paymentKey, paymentId } = await unknownPayment();
    tossState.set(paymentKey, () => ({ status: 200, body: tossPaymentFor(orderId, paymentKey, {}) }));

    await reconciler.reconcileDue(later());

    expect(await paymentRow(paymentId)).toMatchObject({ status: 'DONE' });
    expect(await orderStatus(orderId)).toBe('PAID');
    expect(await eventTypes(paymentId)).toEqual(['PAYMENT_CONFIRMED']);
    const ledger = await ctx.dataSource.query<{ transaction_type: string }[]>(
      'SELECT transaction_type FROM tb_ledger_transaction WHERE reference_id = $1',
      [paymentId],
    );
    expect(ledger).toEqual([{ transaction_type: 'PAYMENT_CAPTURED' }]);
    // 대사는 서비스의 활성 토스 키로 조회한다
    expect(tossLookupsOf(paymentKey)[0].headers.authorization).toBe(
      `Basic ${Buffer.from(`${service.tossSecretKey}:`).toString('base64')}`,
    );
  });

  it('확정 뒤 서비스가 같은 paymentKey로 다시 승인하면 확정된 결과(200 DONE)를 받는다', async () => {
    const { orderId, paymentKey } = await unknownPayment();
    tossState.set(paymentKey, () => ({ status: 200, body: tossPaymentFor(orderId, paymentKey, {}) }));
    await reconciler.reconcileDue(later());

    const res = await confirm(orderId, paymentKey);

    expect(res.status).toBe(200);
    expect(dataOf<{ status: string }>(res).status).toBe('DONE');
  });

  it('토스가 승인 실패(ABORTED)면 FAILED + 토스 사유 — 주문은 다른 수단으로 다시 결제할 수 있다', async () => {
    const { orderId, paymentKey, paymentId } = await unknownPayment();
    tossState.set(paymentKey, () => ({
      status: 200,
      body: tossPaymentFor(orderId, paymentKey, {
        status: 'ABORTED',
        approvedAt: null,
        failure: { code: 'REJECT_CARD_COMPANY', message: '카드사 거절' },
      }),
    }));

    await reconciler.reconcileDue(later());

    expect(await paymentRow(paymentId)).toMatchObject({ status: 'FAILED', failure_code: 'REJECT_CARD_COMPANY' });
    expect(await eventTypes(paymentId)).toEqual(['PAYMENT_FAILED']);
    expect(await orderStatus(orderId)).toBe('PENDING');

    toss.reset(); // 새 승인은 바로 성공
    expect((await confirm(orderId, `tgen_rc_retry_${seq++}`)).status).toBe(200);
  });

  it('토스에서 승인 없이 만료(EXPIRED)됐으면 EXPIRED + PAYMENT_FAILED 이벤트', async () => {
    const { orderId, paymentKey, paymentId } = await unknownPayment();
    tossState.set(paymentKey, () => ({
      status: 200,
      body: tossPaymentFor(orderId, paymentKey, { status: 'EXPIRED', approvedAt: null, card: null }),
    }));

    await reconciler.reconcileDue(later());

    expect((await paymentRow(paymentId)).status).toBe('EXPIRED');
    expect(await eventTypes(paymentId)).toEqual(['PAYMENT_FAILED']);

    // 만료된 paymentKey로 다시 승인하면 성공처럼 보이지 않게 실패로 답한다
    const again = await confirm(orderId, paymentKey);
    expect(again.status).toBe(402);
    expect(errorOf(again)).toMatchObject({
      code: 'PAYMENT_REJECTED',
      detail: { paymentStatus: 'EXPIRED', pgCode: 'EXPIRED' },
    });
  });

  it('hub가 선기록 뒤 결과를 반영하지 못하고 멈춘 IN_PROGRESS도 확정한다', async () => {
    const { orderId, paymentKey, paymentId } = await unknownPayment();
    await ctx.dataSource.query(`UPDATE tb_payment SET status = 'IN_PROGRESS' WHERE id = $1`, [paymentId]);
    tossState.set(paymentKey, () => ({ status: 200, body: tossPaymentFor(orderId, paymentKey, {}) }));

    await reconciler.reconcileDue(later());

    expect((await paymentRow(paymentId)).status).toBe('DONE');
  });

  it.each([
    [
      '아직 승인 전(IN_PROGRESS)',
      (paymentKey: string): FakeTossResponse => ({ status: 200, body: { paymentKey, status: 'IN_PROGRESS' } }),
    ],
    [
      '조회 결과 없음(404)',
      (): FakeTossResponse => ({ status: 404, body: { code: 'NOT_FOUND_PAYMENT', message: '없음' } }),
    ],
    [
      '조회도 응답 지연',
      (paymentKey: string): FakeTossResponse => ({ status: 200, body: { paymentKey }, delayMs: 1000 }),
    ],
    [
      '토스 서버 오류',
      (): FakeTossResponse => ({ status: 500, body: { code: 'FAILED_INTERNAL_SYSTEM_PROCESSING', message: '' } }),
    ],
  ])('%s → 확정하지 않고 UNKNOWN 유지, 다음 대사 대상 순서에서는 뒤로', async (_, state) => {
    const { paymentKey, paymentId } = await unknownPayment();
    const before = (await paymentRow(paymentId)).updated_at;
    tossState.set(paymentKey, state);

    await reconciler.reconcileDue(later());

    const after = await paymentRow(paymentId);
    expect(after.status).toBe('UNKNOWN');
    expect(await eventTypes(paymentId)).toEqual([]);
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('토스 응답이 이 결제와 맞지 않으면(금액 다름) 믿지 않고 UNKNOWN 유지', async () => {
    const { orderId, paymentKey, paymentId } = await unknownPayment();
    tossState.set(paymentKey, () => ({
      status: 200,
      body: tossPaymentFor(orderId, paymentKey, { totalAmount: 1 }),
    }));

    await reconciler.reconcileDue(later());

    expect((await paymentRow(paymentId)).status).toBe('UNKNOWN');
    expect(await orderStatus(orderId)).toBe('PENDING');
  });

  it('한 건이 실패해도(복호화할 수 없는 토스 키 등) 배치 전체가 멈추지 않는다 — 실패 건은 뒤로 보내고 다음 건을 처리', async () => {
    const broken = await onboardPayableService(ctx);
    const brokenAuth = { Authorization: `Bearer ${broken.apiKey}` };
    const brokenOrder = await ctx
      .http()
      .post('/api/v1/orders')
      .set(brokenAuth)
      .send({
        externalOrderId: `rc-broken-${seq++}`,
        externalUserId: 'user-1',
        orderName: '요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 30000, quantity: 1 }],
        totalAmount: 30000,
      });
    const brokenRes = await ctx
      .http()
      .post('/api/v1/payments/confirm')
      .set(brokenAuth)
      .send({
        orderId: dataOf<{ orderId: string }>(brokenOrder).orderId,
        paymentKey: `tgen_rc_broken_${seq++}`,
        amount: 30000,
      });
    const brokenPaymentId = errorOf(brokenRes).detail?.paymentId as string;
    // 키링에 없는 키로 암호화된 것처럼 암호문을 망가뜨린다
    await ctx.dataSource.query(
      `UPDATE tb_pg_credential SET secret_key_enc = decode(repeat('00', 40), 'hex') WHERE service_id = $1`,
      [broken.serviceId],
    );
    await ctx.dataSource.query(`UPDATE tb_payment SET updated_at = now() - interval '1 hour' WHERE id = $1`, [
      brokenPaymentId,
    ]);

    const { orderId, paymentKey, paymentId } = await unknownPayment();
    tossState.set(paymentKey, () => ({ status: 200, body: tossPaymentFor(orderId, paymentKey, {}) }));

    const result = await reconciler.reconcileDue(later());

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect((await paymentRow(paymentId)).status).toBe('DONE');
    const brokenRow = await paymentRow(brokenPaymentId);
    expect(brokenRow.status).toBe('UNKNOWN');
    expect(new Date(brokenRow.updated_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('방금 생긴 결과 불명 결제는 건드리지 않는다 (진행 중인 승인과 겹치지 않게 2분 이상 지난 것만)', async () => {
    const { paymentKey, paymentId } = await unknownPayment();

    await reconciler.reconcileDue(new Date());

    expect(tossLookupsOf(paymentKey)).toHaveLength(0);
    expect((await paymentRow(paymentId)).status).toBe('UNKNOWN');
  });
});
