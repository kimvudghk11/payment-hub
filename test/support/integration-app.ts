import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { initializeTransactionalContext } from 'typeorm-transactional';
import { AppModule } from '../../src/app.module';
import { setupApp } from '../../src/app.setup';
import { testDbConfig } from '../setup/test-db';

export const ADMIN_KEY = 'integration-admin-key';
export const ADMIN_ACTOR = 'admin-7';
export const adminHeaders = {
  Authorization: `Bearer ${ADMIN_KEY}`,
  'X-Admin-Actor-Id': ADMIN_ACTOR,
  'X-Admin-Actor-Name': encodeURIComponent('홍길동'),
};

export interface IntegrationApp {
  app: INestApplication<App>;
  dataSource: DataSource;
  http: () => ReturnType<typeof request>;
}

/**
 * 실제 AppModule + 테스트 DB(globalSetup이 schema.sql로 만든 DB)로 앱을 띄운다.
 * typeorm-transactional 제약으로 테스트 파일당 한 번만 호출한다. env로 설정을 덮어쓸 수 있다 (예: 가짜 토스 주소).
 */
export const createIntegrationApp = async (env: Record<string, string> = {}): Promise<IntegrationApp> => {
  const db = testDbConfig();
  Object.assign(process.env, {
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_USERNAME: db.user,
    DB_PASSWORD: db.password,
    DB_DATABASE: db.database,
    PG_ENVIRONMENT: 'TEST',
    ADMIN_API_KEY_HASHES: createHash('sha256').update(ADMIN_KEY).digest('hex'),
    ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
    ENCRYPTION_KEY_ID: 'v1',
    // 배치(웹훅 발송·대사)는 테스트가 직접 호출한다 (주기 실행은 스케줄러 테스트에서만)
    WEBHOOK_DISPATCH_ENABLED: 'false',
    RECONCILE_ENABLED: 'false',
    ORDER_EXPIRY_ENABLED: 'false',
    BILLING_KEY_PG_DELETE_ENABLED: 'false',
    ...env,
  });

  initializeTransactionalContext();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
  setupApp(app);
  await app.init();

  return { app, dataSource: app.get(DataSource), http: () => request(app.getHttpServer()) };
};

/** 테스트마다 겹치지 않는 서비스 코드 (영문 대문자·숫자·_ 20자 이하) */
export const uniqueServiceCode = (): string => `T_${randomBytes(6).toString('hex').toUpperCase()}`;

export interface SuccessBody<T> {
  success: true;
  message: string;
  data: T;
}
export interface ErrorBody {
  success: false;
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}
export const dataOf = <T>(res: request.Response): T => (res.body as SuccessBody<T>).data;
export const errorOf = (res: request.Response): ErrorBody => res.body as ErrorBody;
