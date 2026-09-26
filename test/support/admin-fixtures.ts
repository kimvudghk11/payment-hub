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
