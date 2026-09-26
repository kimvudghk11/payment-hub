import { IntegrationApp, adminHeaders, dataOf, uniqueServiceCode } from './integration-app';

export interface CreatedService {
  serviceId: string;
  code: string;
}

/** 관리자 API로 서비스를 등록한다 (실제 API 경로를 그대로 사용) */
export const createService = async (ctx: IntegrationApp): Promise<CreatedService> => {
  const res = await ctx
    .http()
    .post('/api/v1/admin/services')
    .set(adminHeaders)
    .send({ code: uniqueServiceCode(), name: '테스트 서비스' });
  if (res.status !== 201) throw new Error(`서비스 등록 실패: ${res.status} ${JSON.stringify(res.body)}`);
  return dataOf<CreatedService>(res);
};

/** 관리자 API로 API 키를 발급하고 평문을 돌려준다 */
export const issueApiKey = async (ctx: IntegrationApp, serviceId: string): Promise<string> => {
  const res = await ctx
    .http()
    .post(`/api/v1/admin/services/${serviceId}/api-keys`)
    .set(adminHeaders)
    .send({ label: 'test' });
  if (res.status !== 201) throw new Error(`API 키 발급 실패: ${res.status} ${JSON.stringify(res.body)}`);
  return dataOf<{ apiKey: string }>(res).apiKey;
};

export const auditActionsOf = async (ctx: IntegrationApp, targetId: string): Promise<string[]> =>
  (
    await ctx.dataSource.query<{ action: string }[]>(
      'SELECT action FROM tb_admin_audit_log WHERE target_id = $1 ORDER BY created_at',
      [targetId],
    )
  ).map((row) => row.action);

export interface PayableService {
  serviceId: string;
  apiKey: string;
  /** 가짜 토스가 받은 Basic 인증을 검증할 때 사용 */
  tossSecretKey: string;
}

/**
 * 결제까지 가능한 서비스: 서비스 등록(webhookUrl) → 토스 키 → 상품 유형 PLAN → API 키.
 * docs/guides/admin-integration.md의 온보딩 순서 그대로.
 */
export const onboardPayableService = async (
  ctx: IntegrationApp,
  options: { webhookUrl?: string | null } = {},
): Promise<PayableService> => {
  const suffix = uniqueServiceCode().toLowerCase();
  const created = await ctx
    .http()
    .post('/api/v1/admin/services')
    .set(adminHeaders)
    .send({
      code: uniqueServiceCode(),
      name: '결제 테스트 서비스',
      webhookUrl:
        options.webhookUrl === undefined ? 'https://svc.example.com/webhooks/payment-hub' : options.webhookUrl,
    });
  if (created.status !== 201) throw new Error(`서비스 등록 실패: ${created.status} ${JSON.stringify(created.body)}`);
  const { serviceId } = dataOf<CreatedService>(created);

  const tossSecretKey = `test_sk_${suffix}`;
  const credential = await ctx
    .http()
    .post(`/api/v1/admin/services/${serviceId}/pg-credentials`)
    .set(adminHeaders)
    .send({
      environment: 'TEST',
      merchantId: 'tosspayments',
      clientKey: `test_ck_${suffix}`,
      secretKey: tossSecretKey,
    });
  if (credential.status !== 201) throw new Error(`PG 키 등록 실패: ${credential.status}`);

  const productType = await ctx
    .http()
    .post(`/api/v1/admin/services/${serviceId}/product-types`)
    .set(adminHeaders)
    .send({ code: 'PLAN', name: '요금제' });
  if (productType.status !== 201) throw new Error(`상품 유형 등록 실패: ${productType.status}`);

  return { serviceId, apiKey: await issueApiKey(ctx, serviceId), tossSecretKey };
};
