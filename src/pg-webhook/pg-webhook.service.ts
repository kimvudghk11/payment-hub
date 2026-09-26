import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../common/database/unique-violation';
import { Payment } from '../payment/domain/payment.entity';
import { PaymentReconciler } from '../payment/payment-reconciler';
import { PgProvider } from '../pg/constants/pg.constants';
import { PgWebhookEvent } from './domain/pg-webhook-event.entity';

/** 토스 웹훅 본문에서 hub가 쓰는 값 */
interface ParsedTossWebhook {
  eventType: string;
  paymentKey: string | null;
  orderId: string | null;
  status: string;
  createdAt: string;
}

export type PgWebhookOutcome = 'PROCESSED' | 'IGNORED' | 'FAILED' | 'DUPLICATE';

/**
 * 토스 → hub 웹훅. 페이로드는 "무언가 바뀌었다"는 신호로만 쓰고, 반영은 토스 조회 결과로 한다
 * (PaymentReconciler.reconcileOne — 대사와 같은 경로). 그래서 위조된 웹훅이 와도 상태가 바뀌지 않는다.
 * 토스에는 항상 200을 준다: 실패해도 대사 배치가 이어받고, 재전송 폭주를 막는다.
 */
@Injectable()
export class PgWebhookService {
  private readonly logger = new Logger(PgWebhookService.name);

  constructor(
    @InjectRepository(PgWebhookEvent) private readonly events: Repository<PgWebhookEvent>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    private readonly reconciler: PaymentReconciler,
  ) {}

  async receiveToss(body: Record<string, unknown>): Promise<PgWebhookOutcome> {
    const parsed = parseTossWebhook(body);
    const event = PgWebhookEvent.receive(
      {
        eventType: parsed.eventType,
        reference: parsed.paymentKey ?? parsed.orderId ?? '-',
        status: parsed.status,
        createdAt: parsed.createdAt,
      },
      body,
      new Date(),
    );
    try {
      await this.events.save(event);
    } catch (error) {
      if (isUniqueViolation(error, 'uq_tb_pg_webhook_event_dedup')) return 'DUPLICATE';
      throw error;
    }

    const outcome = await this.process(parsed, event);
    await this.events.save(event);
    return outcome;
  }

  private async process(parsed: ParsedTossWebhook, event: PgWebhookEvent): Promise<PgWebhookOutcome> {
    const now = new Date();
    const payment = await this.findPayment(parsed);
    if (!payment) {
      event.markIgnored('hub에 해당 결제가 없습니다.', now);
      return 'IGNORED';
    }
    try {
      const { verified, payment: synced } = await this.reconciler.reconcileOne(payment.paymentId);
      if (verified) {
        event.markProcessed(now);
        return 'PROCESSED';
      }
      if (
        synced.status === payment.status &&
        !['IN_PROGRESS', 'UNKNOWN', 'WAITING_FOR_DEPOSIT'].includes(synced.status)
      ) {
        event.markIgnored(`이미 확정된 결제입니다 (${synced.status}).`, now);
        return 'IGNORED';
      }
      event.markFailed('토스 조회로 재확인하지 못했습니다. 대사 배치가 다시 확인합니다.', now);
      return 'FAILED';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`토스 웹훅 처리 실패 (${event.eventType}): ${message}`);
      event.markFailed(`처리 중 오류: ${message}`.slice(0, 1000), now);
      return 'FAILED';
    }
  }

  /** paymentKey가 있으면 그것으로, 없으면(DEPOSIT_CALLBACK) 주문의 가장 최근 결제 */
  private async findPayment(parsed: ParsedTossWebhook): Promise<Payment | null> {
    if (parsed.paymentKey) {
      const byKey = await this.payments.findOneBy({ provider: PgProvider.TOSS, providerPaymentKey: parsed.paymentKey });
      if (byKey) return byKey;
    }
    if (!parsed.orderId || !UUID.test(parsed.orderId)) return null;
    return this.payments.findOne({ where: { orderId: parsed.orderId }, order: { createdAt: 'DESC' } });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * 토스 웹훅 형식 두 가지:
 * - 일반: { eventType: 'PAYMENT_STATUS_CHANGED', createdAt, data: Payment 객체 }
 * - 가상계좌 입금 콜백: { createdAt, secret, status, transactionKey, orderId } (eventType 없음)
 */
const parseTossWebhook = (body: Record<string, unknown>): ParsedTossWebhook => {
  const data =
    body.data && typeof body.data === 'object'
      ? (body.data as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const eventType = str(body.eventType) ?? (str(body.secret) && str(body.orderId) ? 'DEPOSIT_CALLBACK' : 'UNKNOWN');
  const source = str(body.eventType) ? data : body;
  return {
    eventType,
    paymentKey: str(source.paymentKey),
    orderId: str(source.orderId),
    status: str(source.status) ?? '-',
    createdAt: str(body.createdAt) ?? '-',
  };
};
