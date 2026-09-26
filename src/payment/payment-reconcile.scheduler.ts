import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { registerIntervalJob, unregisterIntervalJob } from '../common/scheduling/interval-job';
import { PaymentReconciler } from './payment-reconciler';

const JOB_NAME = 'payment-reconcile';

/** 대사 배치 (기본 1분): 결제 → 환불 순서. RECONCILE_ENABLED=false면 돌지 않는다 */
@Injectable()
export class PaymentReconcileScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly reconciler: PaymentReconciler,
    private readonly config: ConfigService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    registerIntervalJob({
      registry: this.registry,
      config: this.config,
      logger: new Logger(PaymentReconcileScheduler.name),
      name: JOB_NAME,
      configPrefix: 'RECONCILE',
      defaultIntervalMs: 60_000,
      run: async () => {
        await this.reconciler.reconcileDue();
        await this.reconciler.reconcileCancelsDue();
      },
    });
  }

  onApplicationShutdown(): void {
    unregisterIntervalJob(this.registry, JOB_NAME);
  }
}
