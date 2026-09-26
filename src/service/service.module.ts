import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PgCredential } from './domain/pg-credential.entity';
import { ServiceApiKey } from './domain/service-api-key.entity';
import { ServiceProductType } from './domain/service-product-type.entity';
import { Service } from './domain/service.entity';
import { ServiceController } from './service.controller';
import { ServiceService } from './service.service';

@Module({
  imports: [TypeOrmModule.forFeature([Service, ServiceApiKey, PgCredential, ServiceProductType])],
  controllers: [ServiceController],
  providers: [ServiceService],
  exports: [TypeOrmModule, ServiceService],
})
export class ServiceModule {}
