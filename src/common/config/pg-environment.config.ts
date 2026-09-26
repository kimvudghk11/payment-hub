import { ConfigService } from '@nestjs/config';
import { PgEnvironment } from '../../service/constants/service.constants';

/**
 * 이 배포가 담당하는 PG 환경 (배포 하나 = 환경 하나, CLAUDE.md 6장).
 * 미설정이면 TEST, 알 수 없는 값이면 부팅을 막는다 (LIVE 오타가 조용히 TEST로 바뀌지 않게).
 */
export const pgEnvironmentOf = (config: ConfigService): PgEnvironment => {
  const value = config.get<string>('PG_ENVIRONMENT') ?? PgEnvironment.TEST;
  if (value !== PgEnvironment.TEST && value !== PgEnvironment.LIVE) {
    throw new Error(`PG_ENVIRONMENT는 TEST 또는 LIVE여야 합니다: ${value}`);
  }
  return value;
};
