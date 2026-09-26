import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { WEBHOOK_DISPATCH_BATCH_SIZE, WebhookDispatcher } from './webhook-dispatcher';

const INTERVAL_NAME = 'webhook-dispatch';
const DEFAULT_INTERVAL_MS = 1000;

/**
 * 주기적으로 웹훅을 발송한다. 한 틱에서 배치가 가득 차면 비울 때까지 반복하고, 이전 틱이 안 끝났으면 건너뛴다.
 * WEBHOOK_DISPATCH_ENABLED=false면 돌지 않는다 (테스트, 발송 전용 인스턴스를 따로 둘 때).
 */
@Injectable()
export class WebhookDispatchScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WebhookDispatchScheduler.name);
  private running = false;

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly config: ConfigService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get<string>('WEBHOOK_DISPATCH_ENABLED') === 'false') return;
    const intervalMs = Number(this.config.get<string>('WEBHOOK_DISPATCH_INTERVAL_MS') ?? DEFAULT_INTERVAL_MS);
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(`WEBHOOK_DISPATCH_INTERVAL_MS는 양의 정수(ms)여야 합니다: ${intervalMs}`);
    }
    this.registry.addInterval(
      INTERVAL_NAME,
      setInterval(() => void this.tick(), intervalMs),
    );
  }

  onApplicationShutdown(): void {
    if (this.registry.doesExist('interval', INTERVAL_NAME)) this.registry.deleteInterval(INTERVAL_NAME);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let claimed: number;
      do {
        ({ claimed } = await this.dispatcher.dispatchDue());
      } while (claimed >= WEBHOOK_DISPATCH_BATCH_SIZE);
    } catch (error) {
      // 전달 대상 데이터·비밀값은 로그에 남기지 않는다
      this.logger.error(`웹훅 발송 중 오류: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
