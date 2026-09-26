import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { testDbConfig } from './test-db';

/** 테스트 DB를 새로 만들고 db/schema.sql(SSOT)을 그대로 적용한다. */
export default async function globalSetup(): Promise<void> {
  const config = testDbConfig();

  const admin = new Client({ ...config, database: process.env.TEST_DB_ADMIN_DATABASE ?? 'postgres' });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${config.database}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${config.database}"`);
  } finally {
    await admin.end();
  }

  const client = new Client(config);
  await client.connect();
  try {
    await client.query(readFileSync(join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8'));
  } finally {
    await client.end();
  }
}
