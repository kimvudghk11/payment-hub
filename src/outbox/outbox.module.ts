import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServiceModule } from '../service/service.module';
import { OutboxEvent } from './domain/outbox-event.entity';
import { WebhookDelivery } from './domain/webhook-delivery.entity';
import { EventFeedController } from './event-feed.controller';
import { EventFeedService } from './event-feed.service';
import { OutboxService } from './outbox.service';
import { WebhookDispatchScheduler } from './webhook-dispatch.scheduler';
import { WebhookDispatcher } from './webhook-dispatcher';
import { WebhookSender } from './webhook-sender';

/** 서비스 웹훅 응답은 빨라야 한다 (서비스 가이드: 2xx 먼저, 무거운 처리는 비동기) */
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent, WebhookDelivery]), ServiceModule],
  controllers: [EventFeedController],
  providers: [
    OutboxService,
    EventFeedService,
    WebhookDispatcher,
    WebhookDispatchScheduler,
    {
      provide: WebhookSender,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const timeoutMs = Number(config.get<string>('WEBHOOK_TIMEOUT_MS') ?? DEFAULT_WEBHOOK_TIMEOUT_MS);
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
          throw new Error(`WEBHOOK_TIMEOUT_MS는 양의 정수(ms)여야 합니다: ${timeoutMs}`);
        }
        return new WebhookSender(timeoutMs);
      },
    },
  ],
  exports: [OutboxService],
})
export class OutboxModule {}
