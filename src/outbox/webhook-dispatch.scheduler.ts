import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { registerIntervalJob, unregisterIntervalJob } from '../common/scheduling/interval-job';
import { WEBHOOK_DISPATCH_BATCH_SIZE, WebhookDispatcher } from './webhook-dispatcher';

const JOB_NAME = 'webhook-dispatch';

/**
 * 주기적으로 웹훅을 발송한다 (기본 1초). 한 틱에서 배치가 가득 차면 비울 때까지 반복한다.
 * WEBHOOK_DISPATCH_ENABLED=false면 돌지 않는다 (테스트, 발송 전용 인스턴스를 따로 둘 때).
 */
@Injectable()
export class WebhookDispatchScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly config: ConfigService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    registerIntervalJob({
      registry: this.registry,
      config: this.config,
      logger: new Logger(WebhookDispatchScheduler.name),
      name: JOB_NAME,
      configPrefix: 'WEBHOOK_DISPATCH',
      defaultIntervalMs: 1000,
      run: async () => {
        let claimed: number;
        do {
          ({ claimed } = await this.dispatcher.dispatchDue());
        } while (claimed >= WEBHOOK_DISPATCH_BATCH_SIZE);
      },
    });
  }

  onApplicationShutdown(): void {
    unregisterIntervalJob(this.registry, JOB_NAME);
  }
}
