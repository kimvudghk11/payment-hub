import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { FakeToss } from '../support/fake-toss';
import { IntegrationApp, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface BillingKeyData {
  billingKeyId: string;
  externalUserId: string;
  cardCompany: string | null;
  cardNumberMasked: string | null;
  status: string;
  revokedAt: string | null;
  createdAt: string;
}

let seq = 0;

describe('서비스 API — 빌링키 /billing-keys', () => {
  const toss = new FakeToss();
  let ctx: IntegrationApp;
  let service: PayableService;
  let other: PayableService;

  const auth = (target: PayableService = service) => ({ Authorization: `Bearer ${target.apiKey}` });
  const issue = (body: Record<string, unknown>, target: PayableService = service) =>
    ctx.http().post('/api/v1/billing-keys').set(auth(target)).send(body);
  const issueBody = (externalUserId = 'user-1') => ({
    externalUserId,
    customerKey: `c_${externalUserId}_${seq++}`,
    authKey: `bln_${seq++}`,
  });

  beforeAll(async () => {
    ctx = await createIntegrationApp({ TOSS_API_BASE_URL: await toss.start(), TOSS_API_TIMEOUT_MS: '300' });
    service = await onboardPayableService(ctx);
    other = await onboardPayableService(ctx);
  });
  beforeEach(() =>
    toss.respond((request) => ({
      status: 200,
      body: {
        customerKey: request.body.customerKey,
        billingKey: `bk_SECRET_${String(request.body.authKey)}`,
        cardCompany: '현대',
        cardNumber: '433012******1234',
        card: { issuerCode: '61', number: '433012******1234', cardType: '신용' },
      },
    })),
  );
  afterEach(() => toss.reset());
  afterAll(async () => {
    await ctx.app.close();
    await toss.close();
  });

  it('등록: 토스로 발급해 201, 응답·DB 어디에도 빌링키 원문이 없다', async () => {
    const body = issueBody();
    const res = await issue(body);

    expect(res.status).toBe(201);
    const key = dataOf<BillingKeyData>(res);
    expect(key).toMatchObject({
      externalUserId: 'user-1',
      cardCompany: '현대',
      cardNumberMasked: '433012******1234',
      status: 'ACTIVE',
      revokedAt: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('bk_SECRET');
    expect(toss.requests[0]).toMatchObject({
      path: '/v1/billing/authorizations/issue',
      body: { authKey: body.authKey, customerKey: body.customerKey },
    });

    const [row] = await ctx.dataSource.query<{ billing_key_enc: Buffer; customer_key: string }[]>(
      'SELECT billing_key_enc, customer_key FROM tb_billing_key WHERE id = $1',
      [key.billingKeyId],
    );
    expect(row.customer_key).toBe(body.customerKey);
    expect(row.billing_key_enc.toString('utf8')).not.toContain('bk_SECRET');
  });

  it('카드 등록 거절 → 402 BILLING_KEY_REJECTED + 토스 사유, 저장 안 함', async () => {
    toss.respond(() => ({
      status: 400,
      body: { code: 'INVALID_CARD_NUMBER', message: '카드번호를 다시 확인해주세요.' },
    }));
    const res = await issue(issueBody('user-rejected'));

    expect(res.status).toBe(402);
    expect(errorOf(res)).toMatchObject({
      code: 'BILLING_KEY_REJECTED',
      detail: { pgCode: 'INVALID_CARD_NUMBER', pgMessage: '카드번호를 다시 확인해주세요.' },
    });
    const list = await ctx.http().get('/api/v1/billing-keys?externalUserId=user-rejected').set(auth());
    expect(dataOf<{ data: unknown[] }>(list).data).toEqual([]);
  });

  it('customerKey 형식이 토스 규칙(영문·숫자·-_=.@, 2~300자)에 맞지 않으면 400 INVALID_REQUEST', async () => {
    const res = await issue({ ...issueBody(), customerKey: '한글키' });

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('INVALID_REQUEST');
    expect(toss.requests).toHaveLength(0);
  });

  it('목록: 서비스 + 사용자의 활성 수단만 (다른 사용자·다른 서비스·폐기된 수단 제외)', async () => {
    const mine = dataOf<BillingKeyData>(await issue(issueBody('user-list')));
    const revoked = dataOf<BillingKeyData>(await issue(issueBody('user-list')));
    await issue(issueBody('user-other'));
    await issue(issueBody('user-list'), other);
    await ctx.http().delete(`/api/v1/billing-keys/${revoked.billingKeyId}`).set(auth());

    const res = await ctx.http().get('/api/v1/billing-keys?externalUserId=user-list').set(auth());

    expect(res.status).toBe(200);
    expect(dataOf<{ data: BillingKeyData[] }>(res).data.map((key) => key.billingKeyId)).toEqual([mine.billingKeyId]);
  });

  it('목록은 externalUserId가 필수', async () => {
    const res = await ctx.http().get('/api/v1/billing-keys').set(auth());
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('INVALID_REQUEST');
  });

  it('해제: REVOKED + 폐기 시각, 다시 해제해도 200 (멱등)', async () => {
    const key = dataOf<BillingKeyData>(await issue(issueBody()));
    const first = await ctx.http().delete(`/api/v1/billing-keys/${key.billingKeyId}`).set(auth());
    const again = await ctx.http().delete(`/api/v1/billing-keys/${key.billingKeyId}`).set(auth());

    expect(first.status).toBe(200);
    expect(dataOf<BillingKeyData>(first)).toMatchObject({ status: 'REVOKED' });
    expect(dataOf<BillingKeyData>(first).revokedAt).not.toBeNull();
    expect(again.status).toBe(200);
    expect(dataOf<BillingKeyData>(again).revokedAt).toBe(dataOf<BillingKeyData>(first).revokedAt);
  });

  it('다른 서비스의 빌링키는 404 BILLING_KEY_NOT_FOUND (존재 숨김)', async () => {
    const key = dataOf<BillingKeyData>(await issue(issueBody()));
    const res = await ctx.http().delete(`/api/v1/billing-keys/${key.billingKeyId}`).set(auth(other));

    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('BILLING_KEY_NOT_FOUND');
  });
});
