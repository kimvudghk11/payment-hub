import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * 스키마의 단일 진실 공급원은 `db/schema.sql`이다.
 * 엔티티가 스키마를 바꾸지 않도록 synchronize/migrationsRun은 항상 끈다.
 */
export const databaseConfig = (config: ConfigService): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: config.get<string>('DB_HOST', 'localhost'),
  port: Number(config.get<string>('DB_PORT', '5432')),
  username: config.getOrThrow<string>('DB_USERNAME'),
  password: config.getOrThrow<string>('DB_PASSWORD'),
  database: config.getOrThrow<string>('DB_DATABASE'),
  autoLoadEntities: true,
  synchronize: false,
  migrationsRun: false,
  logging: config.get<string>('DB_LOGGING') === 'true',
});
