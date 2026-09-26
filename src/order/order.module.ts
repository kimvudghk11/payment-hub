import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '../outbox/outbox.module';
import { Payment } from '../payment/domain/payment.entity';
import { ServiceModule } from '../service/service.module';
import { OrderItem } from './domain/order-item.entity';
import { Order } from './domain/order.entity';
import { OrderController } from './order.controller';
import { OrderExpirer } from './order-expirer';
import { OrderExpiryScheduler } from './order-expiry.scheduler';
import { OrderService } from './order.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order, OrderItem, Payment]), ServiceModule, OutboxModule],
  controllers: [OrderController],
  providers: [OrderService, OrderExpirer, OrderExpiryScheduler],
  exports: [OrderService],
})
export class OrderModule {}
