import { createHash } from 'crypto';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import { bigintAmountTransformer } from '../../common/database/bigint-amount.transformer';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { OrderItem } from '../../order/domain/order-item.entity';
import type { Order } from '../../order/domain/order.entity';
import { PgProvider } from '../../pg/constants/pg.constants';
import { TossPayment } from '../../pg/toss-payment.types';
import {
  CancelRequestedBy,
  CardType,
  PaymentCancelStatus,
  PaymentMethodType,
  PaymentStatus,
  PaymentType,
} from '../constants/payment.constants';
import { PaymentCancel } from './payment-cancel.entity';

/** 결제 시도 1건. 토스 호출 전에 IN_PROGRESS로 먼저 저장한다. 주문당 살아있는 결제는 1건. */
@Entity({ name: 'tb_payment' })
export class Payment extends BaseEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  paymentId: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  /** BILLING 결제일 때만 */
  @Column({ name: 'billing_key_id', type: 'uuid', nullable: true })
  billingKeyId: string | null;

  @Column({ name: 'provider', type: 'varchar', length: 20 })
  provider: PgProvider;

  @Column({ name: 'payment_type', type: 'varchar', length: 20 })
  paymentType: PaymentType;

  /** 토스 호출 시 Idempotency-Key 헤더로도 사용 */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 100 })
  idempotencyKey: string;

  /** 토스 paymentKey (빌링은 응답 후 채워짐) */
  @Column({ name: 'provider_payment_key', type: 'varchar', length: 200, nullable: true })
  providerPaymentKey: string | null;

  /** 토스 응답 원문 ('카드', '가상계좌' ...). 분류는 methodType 사용 */
  @Column({ name: 'method', type: 'varchar', length: 30, nullable: true })
  method: string | null;

  /** 결제 수단 분류. 결제 확정 전에는 null */
  @Column({ name: 'method_type', type: 'varchar', length: 20, nullable: true })
  methodType: PaymentMethodType | null;

  /** 토스 카드사 코드 (issuerCode) */
  @Column({ name: 'card_company_code', type: 'varchar', length: 10, nullable: true })
  cardCompanyCode: string | null;

  @Column({ name: 'card_type', type: 'varchar', length: 10, nullable: true })
  cardType: CardType | null;

  @Column({ name: 'card_number_masked', type: 'varchar', length: 30, nullable: true })
  cardNumberMasked: string | null;

  /** 0 = 일시불 */
  @Column({ name: 'installment_months', type: 'smallint', nullable: true })
  installmentMonths: number | null;

  /** 토스 easyPay.provider 원문 (토스페이, 카카오페이 ...) */
  @Column({ name: 'easy_pay_provider', type: 'varchar', length: 30, nullable: true })
  easyPayProvider: string | null;

  /** 가상계좌·계좌이체 은행 코드 */
  @Column({ name: 'bank_code', type: 'varchar', length: 10, nullable: true })
  bankCode: string | null;

  /** 가상계좌 입금 계좌 (서비스가 사용자에게 안내) */
  @Column({ name: 'virtual_account_number', type: 'varchar', length: 30, nullable: true })
  virtualAccountNumber: string | null;

  @Column({ name: 'virtual_account_due_at', type: 'timestamptz', nullable: true })
  virtualAccountDueAt: Date | null;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency: string;

  @Column({ name: 'amount', type: 'bigint', transformer: bigintAmountTransformer })
  amount: number;

  /** tb_payment_cancel(DONE) 합계의 캐시. payment 행 락 후 갱신 */
  @Column({ name: 'refunded_amount', type: 'bigint', transformer: bigintAmountTransformer })
  refundedAmount: number;

  @Column({ name: 'status', type: 'varchar', length: 30 })
  status: PaymentStatus;

  /** 토스 원본 에러 코드 (카드 거절 사유 등) */
  @Column({ name: 'failure_code', type: 'varchar', length: 100, nullable: true })
  failureCode: string | null;

  @Column({ name: 'failure_message', type: 'text', nullable: true })
  failureMessage: string | null;

  @Column({ name: 'receipt_url', type: 'text', nullable: true })
  receiptUrl: string | null;

  /** 마지막 PG 응답 원본 (감사·대사용). 서비스 응답에는 포함하지 않는다 */
  @Column({ name: 'provider_response', type: 'jsonb', nullable: true })
  providerResponse: Record<string, unknown> | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @OneToMany(() => PaymentCancel, (cancel) => cancel.payment)
  cancels: PaymentCancel[];

  /**
   * 결제창 인증 후 승인 요청. 토스 호출 전에 IN_PROGRESS로 먼저 저장한다 (외부 호출 전 기록 원칙).
   * 금액은 요청 값이 아니라 주문에 고정된 결제 금액을 쓴다 (대조는 Order.assertConfirmable).
   */
  static startConfirm(params: { order: Order; paymentKey: string }): Payment {
    return Payment.start(params.order, {
      paymentType: PaymentType.NORMAL,
      billingKeyId: null,
      idempotencyKey: confirmIdempotencyKey(params.paymentKey),
      providerPaymentKey: params.paymentKey,
    });
  }

  /**
   * 빌링키 자동결제 요청. 서비스가 정한 멱등키(구독ID-회차 등)로 재요청을 식별한다.
   * paymentKey는 토스 응답을 받은 뒤 채워진다 (applyTossPayment).
   */
  static startBilling(params: { order: Order; billingKeyId: string; idempotencyKey: string }): Payment {
    return Payment.start(params.order, {
      paymentType: PaymentType.BILLING,
      billingKeyId: params.billingKeyId,
      idempotencyKey: `${BILLING_IDEMPOTENCY_PREFIX}${params.idempotencyKey}`,
      providerPaymentKey: null,
    });
  }

  /** 같은 멱등키 자동결제 재요청이 같은 요청인지 (주문·빌링키·금액) */
  matchesBilling(request: { orderId: string; billingKeyId: string; amount: number }): boolean {
    return (
      this.orderId === request.orderId && this.billingKeyId === request.billingKeyId && this.amount === request.amount
    );
  }

  private static start(
    order: Order,
    fields: Pick<Payment, 'paymentType' | 'billingKeyId' | 'idempotencyKey' | 'providerPaymentKey'>,
  ): Payment {
    const payment = new Payment();
    payment.orderId = order.orderId;
    payment.serviceId = order.serviceId;
    payment.billingKeyId = fields.billingKeyId;
    payment.provider = PgProvider.TOSS;
    payment.paymentType = fields.paymentType;
    payment.idempotencyKey = fields.idempotencyKey;
    payment.providerPaymentKey = fields.providerPaymentKey;
    payment.method = null;
    payment.methodType = null;
    payment.cardCompanyCode = null;
    payment.cardType = null;
    payment.cardNumberMasked = null;
    payment.installmentMonths = null;
    payment.easyPayProvider = null;
    payment.bankCode = null;
    payment.virtualAccountNumber = null;
    payment.virtualAccountDueAt = null;
    payment.currency = order.currency;
    payment.amount = order.totalAmount;
    payment.refundedAmount = 0;
    payment.status = PaymentStatus.IN_PROGRESS;
    payment.failureCode = null;
    payment.failureMessage = null;
    payment.receiptUrl = null;
    payment.providerResponse = null;
    payment.approvedAt = null;
    return payment;
  }

  /**
   * 토스 승인·조회 응답 반영. 토스 method 원문은 method에 두고, 조회·리포트용 분류(methodType 등)를 정규화해 채운다.
   * 토스 DONE·WAITING_FOR_DEPOSIT은 그대로, ABORTED(승인 실패)는 FAILED + 토스 사유, EXPIRED(승인 없이 만료)는 EXPIRED.
   * 그 외(READY·IN_PROGRESS 등 아직 승인 전)는 확정하지 않고 UNKNOWN으로 두어 대사가 다시 확인한다.
   * 가상계좌 입금 대기에서는: 입금(DONE) → DONE, 입금 전 만료·취소(EXPIRED·CANCELED) → EXPIRED, 그 외는 입금 대기 유지.
   */
  applyTossPayment(response: TossPayment): void {
    const waitingForDeposit = this.status === PaymentStatus.WAITING_FOR_DEPOSIT;
    if (!waitingForDeposit) this.assertUnresolved('토스 응답 반영');
    // 자동결제는 토스 응답에서 처음 paymentKey를 받는다
    if (!this.providerPaymentKey && response.paymentKey) this.providerPaymentKey = response.paymentKey;
    this.method = response.method;
    this.methodType = classifyMethod(response.method);
    this.cardCompanyCode = response.card?.issuerCode ?? null;
    this.cardType = response.card ? classifyCardType(response.card.cardType) : null;
    this.cardNumberMasked = response.card?.number ?? null;
    this.installmentMonths = response.card?.installmentPlanMonths ?? null;
    this.easyPayProvider = response.easyPay?.provider ?? null;
    this.bankCode = response.virtualAccount?.bankCode ?? response.transfer?.bankCode ?? null;
    this.virtualAccountNumber = response.virtualAccount?.accountNumber ?? null;
    this.virtualAccountDueAt = response.virtualAccount ? new Date(response.virtualAccount.dueDate) : null;
    this.receiptUrl = response.receipt?.url ?? null;
    this.approvedAt = response.approvedAt ? new Date(response.approvedAt) : null;
    this.providerResponse = response as unknown as Record<string, unknown>;
    this.status = waitingForDeposit
      ? (DEPOSIT_TOSS_STATUSES[response.status] ?? PaymentStatus.WAITING_FOR_DEPOSIT)
      : (RESOLVED_TOSS_STATUSES[response.status] ?? PaymentStatus.UNKNOWN);
    if (this.status === PaymentStatus.FAILED) {
      this.failureCode = response.failure?.code ?? response.status;
      this.failureMessage = response.failure?.message ?? null;
    }
  }

  /** 토스가 승인을 거절한 확정 실패. 원본 코드·메시지는 서비스가 사용자에게 사유를 보여줄 수 있게 보존한다 */
  markFailed(failure: { code: string; message: string; response: Record<string, unknown> | null }): void {
    this.assertUnresolved('실패 처리');
    this.status = PaymentStatus.FAILED;
    this.failureCode = failure.code;
    this.failureMessage = failure.message;
    this.providerResponse = failure.response;
  }

  /** 타임아웃·5xx 등 결과를 모르는 경우. 대사 배치가 토스 조회로 확정한다 */
  markUnknown(response: Record<string, unknown> | null): void {
    this.assertUnresolved('결과 불명 처리');
    this.status = PaymentStatus.UNKNOWN;
    if (response) this.providerResponse = response;
  }

  /**
   * 환불 요청. 토스 호출 전에 기록할 REQUESTED 취소를 만들고 cancels에 붙인다 (결제 금액·상태는 확정 때 바뀜).
   * 상한 = 환불 가능 금액 − 처리 중(REQUESTED·UNKNOWN) 취소 합계. 결제 행 락 + cancels 로드 상태에서 호출해야
   * 동시에 들어온 부분 환불 합계가 결제 금액을 넘지 않는다. 금액 계산(일할 등)은 서비스 책임이고 hub는 상한만 본다.
   * @param orderItems 이 결제 주문의 항목 (항목별 취소 수량 검증용)
   */
  requestCancel(request: CancelRequest, orderItems: OrderItem[]): PaymentCancel {
    if (!CANCELABLE_STATUSES.has(this.status)) throw new BusinessException(ErrorCode.PAYMENT_NOT_CANCELABLE);
    const pending = this.cancels.filter((cancel) => cancel.isPending);
    const available = this.refundableAmount - pending.reduce((sum, cancel) => sum + cancel.amount, 0);
    if (request.amount > available) {
      throw new BusinessException(ErrorCode.CANCEL_AMOUNT_EXCEEDED, { refundableAmount: available });
    }
    assertCancelItems(request, orderItems, pending);

    const cancel = PaymentCancel.request({
      paymentId: this.paymentId,
      serviceId: this.serviceId,
      idempotencyKey: request.idempotencyKey,
      amount: request.amount,
      reasonCode: request.reasonCode,
      reasonDetail: request.reasonDetail ?? null,
      requestedBy: request.requestedBy,
      items: request.items ?? [],
    });
    this.cancels.push(cancel);
    return cancel;
  }

  /** 토스 취소가 확정(DONE)된 취소를 반영: 환불 누적, 전액이면 CANCELED 아니면 PARTIAL_CANCELED */
  applyCanceled(cancel: PaymentCancel): void {
    if (cancel.status !== PaymentCancelStatus.DONE) {
      throw new Error(`취소 ${cancel.paymentCancelId}: ${cancel.status} 상태는 결제에 반영할 수 없음`);
    }
    if (!CANCELABLE_STATUSES.has(this.status) || cancel.amount > this.refundableAmount) {
      throw new Error(
        `결제 ${this.paymentId}: ${this.status}·환불 가능 ${this.refundableAmount}에 ${cancel.amount} 반영 불가`,
      );
    }
    this.refundedAmount += cancel.amount;
    this.status = this.refundedAmount === this.amount ? PaymentStatus.CANCELED : PaymentStatus.PARTIAL_CANCELED;
  }

  /** 승인된(DONE·PARTIAL_CANCELED) 결제만 환불 가능. 그 외 상태는 0 */
  get refundableAmount(): number {
    return CANCELABLE_STATUSES.has(this.status) ? this.amount - this.refundedAmount : 0;
  }

  private assertUnresolved(action: string): void {
    if (this.status !== PaymentStatus.IN_PROGRESS && this.status !== PaymentStatus.UNKNOWN) {
      throw new Error(`결제 ${this.paymentId}: ${this.status} 상태에서는 ${action} 불가`);
    }
  }
}

export interface CancelRequest {
  /** 서비스가 정한 값. (서비스, idempotencyKey)로 재요청을 식별 */
  idempotencyKey: string;
  amount: number;
  reasonCode: string;
  reasonDetail?: string | null;
  requestedBy: CancelRequestedBy;
  /** 항목별 취소 기록 (선택). 주면 금액 합계 = amount */
  items?: { orderItemId: string; quantity: number; amount: number }[];
}

/** 항목 검증 실패는 필드별 메시지로 (INVALID_REQUEST detail.errors 형식) */
const assertCancelItems = (request: CancelRequest, orderItems: OrderItem[], pending: PaymentCancel[]): void => {
  const items = request.items ?? [];
  if (items.length === 0) return;

  const errors: { field: string; message: string }[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const orderItem = orderItems.find((candidate) => candidate.orderItemId === item.orderItemId);
    if (!orderItem) {
      errors.push({ field: `items.${index}.orderItemId`, message: '이 결제의 주문 항목이 아닙니다.' });
      return;
    }
    if (seen.has(item.orderItemId)) {
      errors.push({ field: `items.${index}.orderItemId`, message: '같은 항목을 두 번 지정했습니다.' });
      return;
    }
    seen.add(item.orderItemId);
    const pendingQuantity = pending
      .flatMap((cancel) => cancel.items)
      .filter((pendingItem) => pendingItem.orderItemId === item.orderItemId)
      .reduce((sum, pendingItem) => sum + pendingItem.quantity, 0);
    const cancelable = orderItem.quantity - orderItem.canceledQuantity - pendingQuantity;
    if (item.quantity > cancelable) {
      errors.push({ field: `items.${index}.quantity`, message: `취소 가능 수량(${cancelable}개)을 넘었습니다.` });
    }
  });
  const itemsAmount = items.reduce((sum, item) => sum + item.amount, 0);
  if (errors.length === 0 && itemsAmount !== request.amount) {
    errors.push({
      field: 'items',
      message: `항목 금액 합계(${itemsAmount})가 환불 금액(${request.amount})과 다릅니다.`,
    });
  }
  if (errors.length > 0) throw new BusinessException(ErrorCode.INVALID_REQUEST, { errors });
};

/** 자동결제 멱등키 접두사 — 결제 승인(confirm:)과 서비스 멱등키가 섞이지 않게. 서비스 키는 최대 90자 */
export const BILLING_IDEMPOTENCY_PREFIX = 'billing:';

/** 토스 Idempotency-Key·tb_payment.idempotency_key. paymentKey(최대 200자)를 해시해 컬럼 한도(100) 안에 맞춘다 */
const confirmIdempotencyKey = (paymentKey: string): string =>
  `confirm:${createHash('sha256').update(paymentKey).digest('hex')}`;

const RESOLVED_TOSS_STATUSES: Record<string, PaymentStatus> = {
  DONE: PaymentStatus.DONE,
  WAITING_FOR_DEPOSIT: PaymentStatus.WAITING_FOR_DEPOSIT,
  ABORTED: PaymentStatus.FAILED,
  EXPIRED: PaymentStatus.EXPIRED,
};

/** 입금 대기 가상계좌의 토스 상태 → hub. 입금 전 만료·취소는 돈이 들어오지 않았으므로 EXPIRED */
const DEPOSIT_TOSS_STATUSES: Record<string, PaymentStatus> = {
  DONE: PaymentStatus.DONE,
  EXPIRED: PaymentStatus.EXPIRED,
  CANCELED: PaymentStatus.EXPIRED,
};

const CANCELABLE_STATUSES: ReadonlySet<PaymentStatus> = new Set([PaymentStatus.DONE, PaymentStatus.PARTIAL_CANCELED]);

/** 토스 method 원문(한국어 기본, Accept-Language: en이면 영문) → hub 분류. 모르는 값은 null로 두고 원문만 보존 */
const METHOD_TYPES: Record<string, PaymentMethodType> = {
  카드: PaymentMethodType.CARD,
  CARD: PaymentMethodType.CARD,
  가상계좌: PaymentMethodType.VIRTUAL_ACCOUNT,
  VIRTUAL_ACCOUNT: PaymentMethodType.VIRTUAL_ACCOUNT,
  계좌이체: PaymentMethodType.TRANSFER,
  TRANSFER: PaymentMethodType.TRANSFER,
  간편결제: PaymentMethodType.EASY_PAY,
  EASY_PAY: PaymentMethodType.EASY_PAY,
  휴대폰: PaymentMethodType.MOBILE_PHONE,
  MOBILE_PHONE: PaymentMethodType.MOBILE_PHONE,
  문화상품권: PaymentMethodType.GIFT_CERTIFICATE,
  도서문화상품권: PaymentMethodType.GIFT_CERTIFICATE,
  게임문화상품권: PaymentMethodType.GIFT_CERTIFICATE,
  CULTURE_GIFT_CERTIFICATE: PaymentMethodType.GIFT_CERTIFICATE,
  BOOK_GIFT_CERTIFICATE: PaymentMethodType.GIFT_CERTIFICATE,
  GAME_GIFT_CERTIFICATE: PaymentMethodType.GIFT_CERTIFICATE,
};

const classifyMethod = (method: string | null): PaymentMethodType | null => (method && METHOD_TYPES[method]) || null;

const CARD_TYPES: Record<string, CardType> = {
  신용: CardType.CREDIT,
  체크: CardType.CHECK,
  기프트: CardType.GIFT,
};

const classifyCardType = (cardType: string | null): CardType => (cardType && CARD_TYPES[cardType]) || CardType.UNKNOWN;
