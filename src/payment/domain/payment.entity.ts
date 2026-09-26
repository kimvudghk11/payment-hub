import { createHash } from 'crypto';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import { bigintAmountTransformer } from '../../common/database/bigint-amount.transformer';
import type { Order } from '../../order/domain/order.entity';
import { PgProvider } from '../../pg/constants/pg.constants';
import { TossPayment } from '../../pg/toss-payment.types';
import { CardType, PaymentMethodType, PaymentStatus, PaymentType } from '../constants/payment.constants';
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
    const payment = new Payment();
    payment.orderId = params.order.orderId;
    payment.serviceId = params.order.serviceId;
    payment.billingKeyId = null;
    payment.provider = PgProvider.TOSS;
    payment.paymentType = PaymentType.NORMAL;
    payment.idempotencyKey = confirmIdempotencyKey(params.paymentKey);
    payment.providerPaymentKey = params.paymentKey;
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
    payment.currency = params.order.currency;
    payment.amount = params.order.totalAmount;
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
   * 토스 상태가 DONE·WAITING_FOR_DEPOSIT이 아니면 결과를 확정하지 않고 UNKNOWN으로 두어 대사가 판단한다.
   */
  applyTossPayment(response: TossPayment): void {
    this.assertUnresolved('토스 응답 반영');
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
    this.status = RESOLVED_TOSS_STATUSES[response.status] ?? PaymentStatus.UNKNOWN;
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

/** 토스 Idempotency-Key·tb_payment.idempotency_key. paymentKey(최대 200자)를 해시해 컬럼 한도(100) 안에 맞춘다 */
const confirmIdempotencyKey = (paymentKey: string): string =>
  `confirm:${createHash('sha256').update(paymentKey).digest('hex')}`;

const RESOLVED_TOSS_STATUSES: Record<string, PaymentStatus> = {
  DONE: PaymentStatus.DONE,
  WAITING_FOR_DEPOSIT: PaymentStatus.WAITING_FOR_DEPOSIT,
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
