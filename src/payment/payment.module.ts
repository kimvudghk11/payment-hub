import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingKey } from '../billing-key/domain/billing-key.entity';
import { LedgerModule } from '../ledger/ledger.module';
import { Order } from '../order/domain/order.entity';
import { OrderItem } from '../order/domain/order-item.entity';
import { OutboxModule } from '../outbox/outbox.module';
import { PgModule } from '../pg/pg.module';
import { ServiceModule } from '../service/service.module';
import { PaymentCancel } from './domain/payment-cancel.entity';
import { PaymentCancelItem } from './domain/payment-cancel-item.entity';
import { Payment } from './domain/payment.entity';
import { PaymentCancelService } from './payment-cancel.service';
import { PaymentOutcomeService } from './payment-outcome.service';
import { PaymentReconcileScheduler } from './payment-reconcile.scheduler';
import { PaymentReconciler } from './payment-reconciler';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, PaymentCancel, PaymentCancelItem, Order, OrderItem, BillingKey]),
    ServiceModule,
    PgModule,
    LedgerModule,
    OutboxModule,
  ],
  controllers: [PaymentController],
  exports: [PaymentReconciler, PaymentCancelService],
  providers: [
    PaymentService,
    PaymentCancelService,
    PaymentOutcomeService,
    PaymentReconciler,
    PaymentReconcileScheduler,
  ],
})
export class PaymentModule {}
