import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { addTransactionalDataSource } from 'typeorm-transactional';
import { databaseConfig } from './common/config/database.config';
import { AuthModule } from './common/guards/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: databaseConfig,
      // @Transactional()이 이 DataSource를 사용하도록 등록
      dataSourceFactory: (options) => {
        if (!options) throw new Error('TypeORM 설정이 없습니다.');
        return Promise.resolve(addTransactionalDataSource(new DataSource(options)));
      },
    }),
    ScheduleModule.forRoot(),
    AuthModule,
  ],
})
export class AppModule {}
