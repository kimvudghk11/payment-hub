import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerAccount } from '../../ledger/domain/ledger-account.entity';
import { LedgerTransaction } from '../../ledger/domain/ledger-transaction.entity';
import { Order } from '../../order/domain/order.entity';
import { OutboxEvent } from '../../outbox/domain/outbox-event.entity';
import { WebhookDelivery } from '../../outbox/domain/webhook-delivery.entity';
import { Payment } from '../../payment/domain/payment.entity';
import { PaymentModule } from '../../payment/payment.module';
import { AdminAuditModule } from '../audit/admin-audit.module';
import { AdminPaymentController } from './admin-payment.controller';
import { AdminPaymentService } from './admin-payment.service';

/** 전 서비스 결제 조회·수동 환불 (CLAUDE.md 7장 admin/payment) */
@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, Order, LedgerTransaction, LedgerAccount, OutboxEvent, WebhookDelivery]),
    PaymentModule,
    AdminAuditModule,
  ],
  controllers: [AdminPaymentController],
  providers: [AdminPaymentService],
})
export class AdminPaymentModule {}
