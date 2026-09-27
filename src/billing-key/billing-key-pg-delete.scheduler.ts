import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { registerIntervalJob, unregisterIntervalJob } from '../common/scheduling/interval-job';
import { BILLING_KEY_PG_DELETE_BATCH_SIZE, BillingKeyPgDeleter } from './billing-key-pg-deleter';

const JOB_NAME = 'billing-key-pg-delete';

/** 해제한 빌링키의 토스 삭제 재시도 배치 (기본 1분). BILLING_KEY_PG_DELETE_ENABLED=false면 돌지 않는다 */
@Injectable()
export class BillingKeyPgDeleteScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly deleter: BillingKeyPgDeleter,
    private readonly config: ConfigService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    registerIntervalJob({
      registry: this.registry,
      config: this.config,
      logger: new Logger(BillingKeyPgDeleteScheduler.name),
      name: JOB_NAME,
      configPrefix: 'BILLING_KEY_PG_DELETE',
      defaultIntervalMs: 60_000,
      run: async () => {
        let checked: number;
        do {
          ({ checked } = await this.deleter.deleteDue());
        } while (checked >= BILLING_KEY_PG_DELETE_BATCH_SIZE);
      },
    });
  }

  onApplicationShutdown(): void {
    unregisterIntervalJob(this.registry, JOB_NAME);
  }
}
