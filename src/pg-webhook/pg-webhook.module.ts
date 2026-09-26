import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from '../payment/domain/payment.entity';
import { PaymentModule } from '../payment/payment.module';
import { PgWebhookEvent } from './domain/pg-webhook-event.entity';
import { PgWebhookController } from './pg-webhook.controller';
import { PgWebhookService } from './pg-webhook.service';

@Module({
  imports: [TypeOrmModule.forFeature([PgWebhookEvent, Payment]), PaymentModule],
  controllers: [PgWebhookController],
  providers: [PgWebhookService],
})
export class PgWebhookModule {}
