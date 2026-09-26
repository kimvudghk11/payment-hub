import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

/**
 * 주기 실행 배치 등록. `<prefix>_ENABLED=false`면 등록하지 않고, 이전 실행이 안 끝났으면 이번 틱은 건너뛴다.
 * 실행 중 예외는 로그만 남기고 다음 틱에 다시 시도한다 (메시지에 비밀값·결제 데이터를 넣지 않는다).
 */
export const registerIntervalJob = (params: {
  registry: SchedulerRegistry;
  config: ConfigService;
  logger: Logger;
  name: string;
  /** 설정 키 접두사. 예: WEBHOOK_DISPATCH → WEBHOOK_DISPATCH_ENABLED, WEBHOOK_DISPATCH_INTERVAL_MS */
  configPrefix: string;
  defaultIntervalMs: number;
  run: () => Promise<void>;
}): void => {
  const { registry, config, logger, name, configPrefix } = params;
  if (config.get<string>(`${configPrefix}_ENABLED`) === 'false') return;

  const intervalMs = Number(config.get<string>(`${configPrefix}_INTERVAL_MS`) ?? params.defaultIntervalMs);
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(`${configPrefix}_INTERVAL_MS는 양의 정수(ms)여야 합니다: ${intervalMs}`);
  }

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await params.run();
    } catch (error) {
      logger.error(`${name} 실행 중 오류: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  registry.addInterval(
    name,
    setInterval(() => void tick(), intervalMs),
  );
};

export const unregisterIntervalJob = (registry: SchedulerRegistry, name: string): void => {
  if (registry.doesExist('interval', name)) registry.deleteInterval(name);
};
