/**
 * [연동 예제] admin 레포 백엔드 → payment-hub 관리자 API 클라이언트.
 * - admin 키는 admin 레포 서버에만 두고, 관리자 로그인·권한 확인은 admin 레포가 먼저 한다
 * - actorId는 요청마다 실제 작업한 관리자로 넘긴다 (감사 로그 actor)
 * 이 파일은 test/docs/example-clients.int-spec.ts가 실제 hub에 붙여 검증한다.
 */
import { callPaymentHub, Page } from './http';
import type { Order, Payment, PaymentCancel, PaymentStatus } from './service-client';

export interface AdminActor {
  actorId: string;
  actorName?: string;
  requestId?: string;
}

export interface AdminService {
  serviceId: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  apiKeyId: string;
  serviceId: string;
  label: string;
  keyPrefix: string;
  keyHint: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface PgCredential {
  pgCredentialId: string;
  serviceId: string;
  provider: 'TOSS';
  environment: 'TEST' | 'LIVE';
  merchantId: string | null;
  clientKey: string | null;
  secretKeyHint: string;
  isActive: boolean;
  createdAt: string;
}

export interface ProductType {
  serviceId: string;
  code: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminPaymentSearch {
  serviceId?: string;
  status?: PaymentStatus[];
  methodType?: string;
  cardCompanyCode?: string;
  externalUserId?: string;
  externalOrderId?: string;
  paymentKey?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

/** 서비스 응답의 결제 + 서비스 ID·토스 paymentKey */
export interface AdminPayment extends Payment {
  serviceId: string;
  providerPaymentKey: string | null;
}

export interface AdminWebhookDelivery {
  webhookDeliveryId: string;
  eventId: string;
  eventType: string;
  serviceId: string;
  status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'RETRYING' | 'DEAD';
  attemptCount: number;
  nextAttemptAt: string;
  lastHttpStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  targetUrl: string;
  occurredAt: string;
}

export interface AdminPaymentDetail extends AdminPayment {
  order: Order;
  cancels: PaymentCancel[];
  ledger: {
    transactionType: string;
    referenceType: string;
    occurredAt: string;
    entries: { accountCode: string; direction: 'DEBIT' | 'CREDIT'; amount: number }[];
  }[];
  webhookDeliveries: AdminWebhookDelivery[];
  /** PG 응답 원본 — 관리자에게만 */
  providerResponse: Record<string, unknown> | null;
}

export class PaymentHubAdminClient {
  constructor(private readonly options: { baseUrl: string; adminKey: string }) {}

  // ---------- 서비스 ----------

  /** webhookSecret은 이 응답에서 1회만 온다 → 서비스 담당자에게 안전하게 전달 */
  async createService(actor: AdminActor, input: { code: string; name: string; webhookUrl?: string }) {
    return this.call<AdminService & { webhookSecret: string }>(actor, 'POST', '/admin/services', input);
  }

  async listServices(
    actor: AdminActor,
    query: { status?: string; includeDeleted?: boolean; limit?: number; cursor?: string } = {},
  ) {
    return this.call<Page<AdminService>>(actor, 'GET', '/admin/services', undefined, query);
  }

  async getService(actor: AdminActor, serviceId: string) {
    return this.call<AdminService>(actor, 'GET', `/admin/services/${serviceId}`);
  }

  async updateService(actor: AdminActor, serviceId: string, input: { name?: string; webhookUrl?: string | null }) {
    return this.call<AdminService>(actor, 'PATCH', `/admin/services/${serviceId}`, input);
  }

  /** 사유 필수 */
  async suspendService(actor: AdminActor, serviceId: string, reason: string) {
    return this.call<AdminService>(actor, 'POST', `/admin/services/${serviceId}/suspend`, { reason });
  }

  async resumeService(actor: AdminActor, serviceId: string, reason?: string) {
    return this.call<AdminService>(actor, 'POST', `/admin/services/${serviceId}/resume`, { reason });
  }

  /** 사유 필수. soft delete */
  async deleteService(actor: AdminActor, serviceId: string, reason: string) {
    return this.call<AdminService>(actor, 'DELETE', `/admin/services/${serviceId}`, { reason });
  }

  /** 새 webhookSecret은 이 응답에서 1회만 */
  async rotateWebhookSecret(actor: AdminActor, serviceId: string) {
    return this.call<{ serviceId: string; webhookSecret: string }>(
      actor,
      'POST',
      `/admin/services/${serviceId}/webhook-secret/rotate`,
    );
  }

  // ---------- API 키 ----------

  /** apiKey 평문은 이 응답에서 1회만 온다 */
  async issueApiKey(actor: AdminActor, serviceId: string, input: { label: string; expiresAt?: string }) {
    return this.call<ApiKey & { apiKey: string }>(actor, 'POST', `/admin/services/${serviceId}/api-keys`, input);
  }

  async listApiKeys(actor: AdminActor, serviceId: string) {
    return this.call<ApiKey[]>(actor, 'GET', `/admin/services/${serviceId}/api-keys`);
  }

  async revokeApiKey(actor: AdminActor, apiKeyId: string) {
    return this.call<ApiKey>(actor, 'POST', `/admin/api-keys/${apiKeyId}/revoke`);
  }

  // ---------- PG 자격증명 ----------

  async registerPgCredential(
    actor: AdminActor,
    serviceId: string,
    input: { environment: 'TEST' | 'LIVE'; merchantId?: string; clientKey: string; secretKey: string },
  ) {
    return this.call<PgCredential>(actor, 'POST', `/admin/services/${serviceId}/pg-credentials`, input);
  }

  async listPgCredentials(actor: AdminActor, serviceId: string) {
    return this.call<PgCredential[]>(actor, 'GET', `/admin/services/${serviceId}/pg-credentials`);
  }

  /** 사유 필수 */
  async deactivatePgCredential(actor: AdminActor, pgCredentialId: string, reason: string) {
    return this.call<PgCredential>(actor, 'POST', `/admin/pg-credentials/${pgCredentialId}/deactivate`, { reason });
  }

  // ---------- 상품 유형 ----------

  async createProductType(actor: AdminActor, serviceId: string, input: { code: string; name: string }) {
    return this.call<ProductType>(actor, 'POST', `/admin/services/${serviceId}/product-types`, input);
  }

  async listProductTypes(actor: AdminActor, serviceId: string, query: { isActive?: boolean } = {}) {
    return this.call<ProductType[]>(actor, 'GET', `/admin/services/${serviceId}/product-types`, undefined, query);
  }

  /** 삭제 대신 isActive: false로 중지 */
  async updateProductType(
    actor: AdminActor,
    serviceId: string,
    code: string,
    input: { name?: string; isActive?: boolean },
  ) {
    return this.call<ProductType>(actor, 'PATCH', `/admin/services/${serviceId}/product-types/${code}`, input);
  }

  // ---------- 결제 조회 ----------

  /** 전 서비스 결제 검색. status는 여러 개 가능 (CS: 토스 paymentKey·사용자 ID로 찾기) */
  async searchPayments(actor: AdminActor, query: AdminPaymentSearch = {}) {
    const { status, ...rest } = query;
    return this.call<Page<AdminPayment>>(actor, 'GET', '/admin/payments', undefined, {
      ...rest,
      status: status?.join(','),
    });
  }

  /** 주문·항목, 취소 이력, 원장 분개, 웹훅 전달 내역, PG 응답 원본 */
  async getPayment(actor: AdminActor, paymentId: string) {
    return this.call<AdminPaymentDetail>(actor, 'GET', `/admin/payments/${paymentId}`);
  }

  // ---------- 운영 큐 ----------

  /** 웹훅 전달 내역. 실패 큐는 status: 'DEAD' */
  async listWebhookDeliveries(
    actor: AdminActor,
    query: { status?: AdminWebhookDelivery['status']; serviceId?: string; limit?: number; cursor?: string } = {},
  ) {
    return this.call<Page<AdminWebhookDelivery>>(actor, 'GET', '/admin/ops/webhook-deliveries', undefined, query);
  }

  /** 서비스의 현재 webhookUrl로 바로 재전송. URL이 원인이었다면 updateService로 먼저 고친다 */
  async redeliverWebhook(actor: AdminActor, deliveryId: string, reason?: string) {
    return this.call<AdminWebhookDelivery>(actor, 'POST', `/admin/ops/webhook-deliveries/${deliveryId}/redeliver`, {
      reason,
    });
  }

  /** 대사 대기 결제 (IN_PROGRESS·UNKNOWN), 오래된 순 */
  async listUnknownPayments(actor: AdminActor, query: { serviceId?: string; limit?: number } = {}) {
    return this.call<Page<AdminPayment>>(actor, 'GET', '/admin/ops/unknown-payments', undefined, query);
  }

  /** 토스 조회로 지금 확정. resolved=false면 토스도 아직 모르거나 이미 확정된 결제 */
  async reconcilePayment(actor: AdminActor, paymentId: string, reason?: string) {
    return this.call<{ resolved: boolean; payment: AdminPayment }>(
      actor,
      'POST',
      `/admin/ops/payments/${paymentId}/reconcile`,
      { reason },
    );
  }

  private async call<T>(
    actor: AdminActor,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.adminKey}`,
      'X-Admin-Actor-Id': actor.actorId,
    };
    if (actor.actorName) headers['X-Admin-Actor-Name'] = encodeURIComponent(actor.actorName);
    if (actor.requestId) headers['X-Request-Id'] = actor.requestId;
    return (await callPaymentHub<T>(this.options.baseUrl, { method, path, body, query, headers })).data;
  }
}
