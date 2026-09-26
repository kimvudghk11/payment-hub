import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { addTransactionalDataSource } from 'typeorm-transactional';
import { AdminServiceModule } from './admin/service/admin-service.module';
import { databaseConfig } from './common/config/database.config';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuthModule } from './common/guards/auth.module';
import { OrderModule } from './order/order.module';
import { PaymentModule } from './payment/payment.module';
import { ServiceModule } from './service/service.module';

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
    CryptoModule,
    AuthModule,
    ServiceModule,
    OrderModule,
    PaymentModule,
    AdminServiceModule,
  ],
})
export class AppModule {}
