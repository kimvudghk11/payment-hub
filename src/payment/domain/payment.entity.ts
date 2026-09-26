import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';
import { bigintAmountTransformer } from '../../common/database/bigint-amount.transformer';
import { PgProvider } from '../../pg/constants/pg.constants';
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
}
