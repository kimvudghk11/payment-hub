import { Module } from '@nestjs/common';
import { ServiceModule } from '../../service/service.module';
import { AdminAuditModule } from '../audit/admin-audit.module';
import { AdminApiKeyController } from './admin-api-key.controller';
import { AdminPgCredentialController } from './admin-pg-credential.controller';
import { AdminPgCredentialService } from './admin-pg-credential.service';
import { AdminProductTypeController } from './admin-product-type.controller';
import { AdminProductTypeService } from './admin-product-type.service';
import { AdminServiceController } from './admin-service.controller';
import { AdminServiceService } from './admin-service.service';

/** 서비스 온보딩 관리: 서비스·API 키·PG 자격증명·상품 유형 (CLAUDE.md 7장 admin/service) */
@Module({
  imports: [ServiceModule, AdminAuditModule],
  controllers: [AdminServiceController, AdminApiKeyController, AdminPgCredentialController, AdminProductTypeController],
  providers: [AdminServiceService, AdminPgCredentialService, AdminProductTypeService],
})
export class AdminServiceModule {}
