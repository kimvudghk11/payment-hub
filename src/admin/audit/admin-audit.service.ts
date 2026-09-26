import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { paginateByCreatedAt } from '../../common/database/cursor-pagination';
import { IPageable } from '../../common/interceptors/response.interceptor';
import { AdminAuditLog } from './domain/admin-audit-log.entity';
import { ListAuditLogsQueryDto } from './dto/admin-audit-log.dto';

/**
 * 감사 로그 기록. 호출하는 쪽의 @Transactional() 안에서 실행되어 관리 쓰기와 함께 커밋·롤백된다.
 */
@Injectable()
export class AdminAuditService {
  constructor(@InjectRepository(AdminAuditLog) private readonly auditLogs: Repository<AdminAuditLog>) {}

  async record(params: Parameters<typeof AdminAuditLog.record>[0]): Promise<void> {
    await this.auditLogs.save(AdminAuditLog.record(params));
  }

  /** 감사 로그 조회 (최신순 cursor). 조회는 감사 로그를 남기지 않는다 */
  list(query: ListAuditLogsQueryDto): Promise<IPageable<AdminAuditLog>> {
    const filtered = this.auditLogs.createQueryBuilder('l').where('1 = 1');
    if (query.actorId) filtered.andWhere('l.actorId = :actorId', { actorId: query.actorId });
    if (query.action) filtered.andWhere('l.action = :action', { action: query.action });
    if (query.targetType) filtered.andWhere('l.targetType = :targetType', { targetType: query.targetType });
    if (query.targetId) filtered.andWhere('l.targetId = :targetId', { targetId: query.targetId });
    if (query.serviceId) filtered.andWhere('l.serviceId = :serviceId', { serviceId: query.serviceId });
    if (query.from) filtered.andWhere('l.createdAt >= :from', { from: new Date(query.from) });
    if (query.to) filtered.andWhere('l.createdAt < :to', { to: new Date(query.to) });
    return paginateByCreatedAt(filtered, {
      alias: 'l',
      idProperty: 'adminAuditLogId',
      limit: query.limit,
      cursor: query.cursor,
    });
  }
}
