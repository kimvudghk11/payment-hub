import { Module } from '@nestjs/common';
import { ServiceModule } from '../../service/service.module';
import { AdminAuditModule } from '../audit/admin-audit.module';
import { AdminApiKeyController } from './admin-api-key.controller';
import { AdminServiceController } from './admin-service.controller';
import { AdminServiceService } from './admin-service.service';

@Module({
  imports: [ServiceModule, AdminAuditModule],
  controllers: [AdminServiceController, AdminApiKeyController],
  providers: [AdminServiceService],
})
export class AdminServiceModule {}
