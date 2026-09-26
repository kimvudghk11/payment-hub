import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServiceModule } from '../service/service.module';
import { OutboxEvent } from './domain/outbox-event.entity';
import { WebhookDelivery } from './domain/webhook-delivery.entity';
import { OutboxService } from './outbox.service';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent, WebhookDelivery]), ServiceModule],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
