import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminAuditLog } from './domain/admin-audit-log.entity';

/**
 * 감사 로그 기록. 호출하는 쪽의 @Transactional() 안에서 실행되어 관리 쓰기와 함께 커밋·롤백된다.
 */
@Injectable()
export class AdminAuditService {
  constructor(@InjectRepository(AdminAuditLog) private readonly auditLogs: Repository<AdminAuditLog>) {}

  async record(params: Parameters<typeof AdminAuditLog.record>[0]): Promise<void> {
    await this.auditLogs.save(AdminAuditLog.record(params));
  }
}
