import { ClientConfig } from 'pg';

/**
 * 통합 테스트 DB 접속 정보. 기본값은 docker-compose.yml과 같다.
 * 테스트 DB는 매 실행마다 DROP 후 재생성되므로 이름이 반드시 `_test`로 끝나야 한다.
 */
export const testDbConfig = (): ClientConfig & { database: string } => {
  const database = process.env.TEST_DB_DATABASE ?? 'payment_hub_test';
  if (!database.endsWith('_test')) {
    throw new Error(`TEST_DB_DATABASE는 '_test'로 끝나야 합니다 (매 실행 DROP됨): ${database}`);
  }
  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME ?? 'payment_hub',
    password: process.env.DB_PASSWORD ?? 'payment_hub',
    database,
  };
};
