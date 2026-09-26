import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../../order/domain/order.entity';
import { OutboxEvent } from '../../outbox/domain/outbox-event.entity';
import { WebhookDelivery } from '../../outbox/domain/webhook-delivery.entity';
import { Payment } from '../../payment/domain/payment.entity';
import { PaymentModule } from '../../payment/payment.module';
import { ServiceModule } from '../../service/service.module';
import { AdminAuditModule } from '../audit/admin-audit.module';
import { AdminOpsController } from './admin-ops.controller';
import { AdminOpsService } from './admin-ops.service';

/** 운영 큐: 대사 대기 결제·수동 대사, 실패 웹훅·재전송 (CLAUDE.md 7장 admin/ops) */
@Module({
  imports: [
    TypeOrmModule.forFeature([WebhookDelivery, OutboxEvent, Payment, Order]),
    ServiceModule,
    PaymentModule,
    AdminAuditModule,
  ],
  controllers: [AdminOpsController],
  providers: [AdminOpsService],
})
export class AdminOpsModule {}
