/**
 * 로컬에서 서비스 연동을 바로 시작할 수 있게 hub에 테스트 서비스를 준비한다.
 * 관리자 API만 사용한다 (DB 직접 수정 없음 → 감사 로그가 남는다).
 *
 *   HUB_URL=http://localhost:3000 ADMIN_API_KEY=phadm_... \
 *   TOSS_CLIENT_KEY=test_ck_... TOSS_SECRET_KEY=test_sk_... \
 *   WEBHOOK_URL=http://localhost:4000/webhooks/payment-hub \
 *   npm run local:onboard
 *
 * 다시 실행하면 같은 SERVICE_CODE의 서비스를 재사용하고 새 API 키만 발급한다.
 */
import { PaymentHubAdminClient } from '../examples/admin-client';
import { PaymentHubError } from '../examples/http';
import { PaymentHubServiceClient } from '../examples/service-client';

export interface LocalOnboardOptions {
  hubUrl: string;
  adminApiKey: string;
  serviceCode: string;
  serviceName: string;
  webhookUrl?: string;
  productTypes: { code: string; name: string }[];
  tossClientKey?: string;
  tossSecretKey?: string;
}

export interface LocalOnboardResult {
  serviceId: string;
  created: boolean;
  /** 서비스 서버 .env에 넣을 값 */
  env: { PAYMENT_HUB_URL: string; PAYMENT_HUB_API_KEY: string; PAYMENT_HUB_WEBHOOK_SECRET?: string };
  /** 발급한 키로 실제 호출해 확인한 결과 */
  verified: { serviceCode: string; clientKey: string | null };
  warnings: string[];
}

const ACTOR = { actorId: 'local-onboard-script', actorName: '로컬 온보딩 스크립트' };

export async function onboardLocalService(options: LocalOnboardOptions): Promise<LocalOnboardResult> {
  const admin = new PaymentHubAdminClient({ baseUrl: options.hubUrl, adminKey: options.adminApiKey });
  const warnings: string[] = [];

  // 1. 서비스: 같은 코드가 있으면 재사용 (웹훅 서명 키는 등록 시 1회만 받을 수 있으므로 재사용 시엔 없음)
  let serviceId: string;
  let webhookSecret: string | undefined;
  const existing = await findServiceByCode(admin, options.serviceCode);
  if (existing) {
    serviceId = existing;
  } else {
    const service = await admin.createService(ACTOR, {
      code: options.serviceCode,
      name: options.serviceName,
      webhookUrl: options.webhookUrl,
    });
    serviceId = service.serviceId;
    webhookSecret = service.webhookSecret;
  }

  // 2. 상품 유형: 이미 있으면 그대로 둔다
  for (const productType of options.productTypes) {
    await admin.createProductType(ACTOR, serviceId, productType).catch(ignoreCode('PRODUCT_TYPE_DUPLICATED'));
  }

  // 3. PG 자격증명: 토스 개발자센터의 테스트 키가 있을 때만
  if (options.tossClientKey && options.tossSecretKey) {
    await admin.registerPgCredential(ACTOR, serviceId, {
      environment: 'TEST',
      clientKey: options.tossClientKey,
      secretKey: options.tossSecretKey,
    });
  } else {
    warnings.push(
      'TOSS_CLIENT_KEY / TOSS_SECRET_KEY가 없어 PG 자격증명 등록을 건너뛰었습니다. 결제창·결제 승인은 등록 후 가능합니다.',
    );
  }

  // 4. API 키 발급 후 실제 호출로 확인
  const { apiKey } = await admin.issueApiKey(ACTOR, serviceId, {
    label: `local-${new Date().toISOString().slice(0, 10)}`,
  });
  const client = new PaymentHubServiceClient({ baseUrl: options.hubUrl, apiKey });
  const me = await client.me();
  const clientKey = await client
    .getPgClientConfig()
    .then((config) => config.clientKey)
    .catch(ignoreCode('PG_CREDENTIAL_NOT_FOUND', null));

  return {
    serviceId,
    created: !existing,
    env: {
      PAYMENT_HUB_URL: options.hubUrl,
      PAYMENT_HUB_API_KEY: apiKey,
      ...(webhookSecret ? { PAYMENT_HUB_WEBHOOK_SECRET: webhookSecret } : {}),
    },
    verified: { serviceCode: me.code, clientKey },
    warnings,
  };
}

const findServiceByCode = async (admin: PaymentHubAdminClient, code: string): Promise<string | undefined> => {
  let cursor: string | undefined;
  do {
    const page = await admin.listServices(ACTOR, { limit: 100, cursor });
    const found = page.data.find((service) => service.code === code);
    if (found) return found.serviceId;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return undefined;
};

/** 특정 에러 코드는 "이미 되어 있음"으로 보고 넘어간다 */
const ignoreCode =
  <T>(code: string, fallback?: T) =>
  (error: unknown): T => {
    if (error instanceof PaymentHubError && error.code === code) return fallback as T;
    throw error;
  };

if (require.main === module) {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`환경변수 ${name}가 필요합니다. (admin 키는 npm run admin-key:generate로 생성)`);
    return value;
  };

  onboardLocalService({
    hubUrl: process.env.HUB_URL ?? 'http://localhost:3000',
    adminApiKey: required('ADMIN_API_KEY'),
    serviceCode: process.env.SERVICE_CODE ?? 'LOCAL_SVC',
    serviceName: process.env.SERVICE_NAME ?? '로컬 테스트 서비스',
    webhookUrl: process.env.WEBHOOK_URL,
    productTypes: (process.env.PRODUCT_TYPES ?? 'PLAN:구독 요금제,ADDON:부가 상품').split(',').map((entry) => {
      const [code, name] = entry.split(':');
      return { code, name: name ?? code };
    }),
    tossClientKey: process.env.TOSS_CLIENT_KEY,
    tossSecretKey: process.env.TOSS_SECRET_KEY,
  })
    .then((result) => {
      console.log(
        `\n서비스 ${result.verified.serviceCode} (${result.serviceId}) ${result.created ? '생성' : '재사용'}\n`,
      );
      console.log('서비스 서버 .env에 추가하세요:');
      for (const [key, value] of Object.entries(result.env)) console.log(`  ${key}=${value}`);
      if (!result.env.PAYMENT_HUB_WEBHOOK_SECRET) {
        console.log('  (기존 서비스라 웹훅 서명 키는 다시 볼 수 없습니다. 필요하면 관리자 API로 교체하세요)');
      }
      console.log(`\n결제창 clientKey: ${result.verified.clientKey ?? '(PG 자격증명 없음)'}`);
      for (const warning of result.warnings) console.warn(`\n⚠ ${warning}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof PaymentHubError ? `${error.code}: ${error.message}` : error);
      process.exit(1);
    });
}
