import { auditActionsOf, createService } from '../support/admin-fixtures';
import { IntegrationApp, adminHeaders, createIntegrationApp, dataOf, errorOf } from '../support/integration-app';

interface ProductTypeData {
  serviceId: string;
  code: string;
  name: string;
  isActive: boolean;
}

describe('관리자 API — 상품 유형', () => {
  let ctx: IntegrationApp;

  beforeAll(async () => {
    ctx = await createIntegrationApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const base = (serviceId: string) => `/api/v1/admin/services/${serviceId}/product-types`;
  const create = (serviceId: string, body: Record<string, unknown>) =>
    ctx.http().post(base(serviceId)).set(adminHeaders).send(body);
  const patch = (serviceId: string, code: string, body: Record<string, unknown>) =>
    ctx
      .http()
      .patch(`${base(serviceId)}/${code}`)
      .set(adminHeaders)
      .send(body);
  /** 상품 유형 감사 로그의 target_id는 "<serviceId>:<code>" */
  const targetOf = (serviceId: string, code: string) => `${serviceId}:${code}`;

  it('등록하면 활성 상태이고 감사 로그 PRODUCT_TYPE_CREATED를 남긴다', async () => {
    const service = await createService(ctx);

    const res = await create(service.serviceId, { code: 'PLAN', name: '구독 요금제' });

    expect(res.status).toBe(201);
    expect(dataOf<ProductTypeData>(res)).toMatchObject({ code: 'PLAN', name: '구독 요금제', isActive: true });
    expect(await auditActionsOf(ctx, targetOf(service.serviceId, 'PLAN'))).toEqual(['PRODUCT_TYPE_CREATED']);
  });

  it('같은 서비스에 같은 코드는 409 PRODUCT_TYPE_DUPLICATED, 다른 서비스는 같은 코드를 쓸 수 있다', async () => {
    const service = await createService(ctx);
    const other = await createService(ctx);
    await create(service.serviceId, { code: 'PLAN', name: '요금제' });

    const duplicated = await create(service.serviceId, { code: 'PLAN', name: '요금제' });
    const otherService = await create(other.serviceId, { code: 'PLAN', name: '요금제' });

    expect(duplicated.status).toBe(409);
    expect(errorOf(duplicated).code).toBe('PRODUCT_TYPE_DUPLICATED');
    expect(otherService.status).toBe(201);
  });

  it('코드 형식이 틀리면 400 INVALID_REQUEST', async () => {
    const service = await createService(ctx);

    const res = await create(service.serviceId, { code: 'plan-a', name: '요금제' });

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('INVALID_REQUEST');
  });

  it('중지·재개·이름 수정은 PATCH, 바뀐 게 없으면 감사 로그를 남기지 않는다', async () => {
    const service = await createService(ctx);
    await create(service.serviceId, { code: 'ADDON', name: '부가 상품' });

    const stopped = await patch(service.serviceId, 'ADDON', { isActive: false });
    await patch(service.serviceId, 'ADDON', { isActive: false });
    const renamed = await patch(service.serviceId, 'ADDON', { name: '추가 옵션', isActive: true });

    expect(dataOf<ProductTypeData>(stopped).isActive).toBe(false);
    expect(dataOf<ProductTypeData>(renamed)).toMatchObject({ name: '추가 옵션', isActive: true });
    expect(await auditActionsOf(ctx, targetOf(service.serviceId, 'ADDON'))).toEqual([
      'PRODUCT_TYPE_CREATED',
      'PRODUCT_TYPE_UPDATED',
      'PRODUCT_TYPE_UPDATED',
    ]);
  });

  it('목록은 isActive로 거를 수 있다', async () => {
    const service = await createService(ctx);
    await create(service.serviceId, { code: 'PLAN', name: '요금제' });
    await create(service.serviceId, { code: 'CREDIT', name: '크레딧' });
    await patch(service.serviceId, 'CREDIT', { isActive: false });

    const all = dataOf<ProductTypeData[]>(await ctx.http().get(base(service.serviceId)).set(adminHeaders));
    const active = dataOf<ProductTypeData[]>(
      await ctx
        .http()
        .get(`${base(service.serviceId)}?isActive=true`)
        .set(adminHeaders),
    );

    expect(all.map((p) => p.code).sort()).toEqual(['CREDIT', 'PLAN']);
    expect(active.map((p) => p.code)).toEqual(['PLAN']);
  });

  it('없는 상품 유형·삭제된 서비스는 404 RESOURCE_NOT_FOUND', async () => {
    const service = await createService(ctx);
    const missing = await patch(service.serviceId, 'NOPE', { isActive: false });
    await ctx.http().delete(`/api/v1/admin/services/${service.serviceId}`).set(adminHeaders).send({ reason: '종료' });
    const deleted = await create(service.serviceId, { code: 'PLAN', name: '요금제' });

    expect(errorOf(missing).code).toBe('RESOURCE_NOT_FOUND');
    expect(errorOf(deleted).code).toBe('RESOURCE_NOT_FOUND');
  });
});
