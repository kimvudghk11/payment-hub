/**
 * 토스페이먼츠 Payment 객체 중 hub가 읽는 필드 (https://docs.tosspayments.com/reference#payment-객체).
 * 원문 전체는 tb_payment.provider_response에 그대로 보존한다.
 */
export interface TossPayment {
  paymentKey: string;
  orderId: string;
  /** READY, IN_PROGRESS, WAITING_FOR_DEPOSIT, DONE, CANCELED, PARTIAL_CANCELED, ABORTED, EXPIRED */
  status: string;
  /** '카드', '가상계좌', '간편결제', '계좌이체', '휴대폰', '문화상품권' ... (Accept-Language에 따라 영문일 수 있음) */
  method: string | null;
  totalAmount: number;
  currency: string;
  approvedAt: string | null;
  card?: {
    issuerCode: string | null;
    number: string | null;
    installmentPlanMonths: number | null;
    /** '신용', '체크', '기프트', '미확인' */
    cardType: string | null;
  } | null;
  virtualAccount?: {
    accountNumber: string;
    bankCode: string;
    dueDate: string;
  } | null;
  transfer?: { bankCode: string } | null;
  easyPay?: { provider: string } | null;
  receipt?: { url: string } | null;
  /** 취소 이력 (오래된 순). 방금 한 취소는 마지막 항목 */
  cancels?: { transactionKey: string; cancelAmount: number; canceledAt: string }[] | null;
  /** ABORTED 등 실패한 결제의 사유 */
  failure?: { code: string; message: string } | null;
}
