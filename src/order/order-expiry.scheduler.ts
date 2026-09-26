import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { registerIntervalJob, unregisterIntervalJob } from '../common/scheduling/interval-job';
import { ORDER_EXPIRY_BATCH_SIZE, OrderExpirer } from './order-expirer';

const JOB_NAME = 'order-expiry';

/** 주문 만료 배치 (기본 1분). ORDER_EXPIRY_ENABLED=false면 돌지 않는다 */
@Injectable()
export class OrderExpiryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly expirer: OrderExpirer,
    private readonly config: ConfigService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    registerIntervalJob({
      registry: this.registry,
      config: this.config,
      logger: new Logger(OrderExpiryScheduler.name),
      name: JOB_NAME,
      configPrefix: 'ORDER_EXPIRY',
      defaultIntervalMs: 60_000,
      run: async () => {
        let expired: number;
        do {
          ({ expired } = await this.expirer.expireDue());
        } while (expired >= ORDER_EXPIRY_BATCH_SIZE);
      },
    });
  }

  onApplicationShutdown(): void {
    unregisterIntervalJob(this.registry, JOB_NAME);
  }
}
