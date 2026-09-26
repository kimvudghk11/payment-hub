import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PgModule } from '../pg/pg.module';
import { ServiceModule } from '../service/service.module';
import { BillingKeyController } from './billing-key.controller';
import { BillingKeyService } from './billing-key.service';
import { BillingKey } from './domain/billing-key.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BillingKey]), ServiceModule, PgModule],
  controllers: [BillingKeyController],
  providers: [BillingKeyService],
  exports: [TypeOrmModule],
})
export class BillingKeyModule {}
