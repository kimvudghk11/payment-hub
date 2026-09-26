import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { CreatedAtEntity } from '../../../common/domain/created-at.entity';
import { BusinessException } from '../../../common/errors/business.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { AdminActor } from '../../../common/types/request-context';
import { AdminAuditAction, REASON_REQUIRED_ACTIONS } from '../constants/admin-audit.constants';

/** admin API를 통한 모든 관리 쓰기 기록. append-only (UPDATE/DELETE는 DB 트리거가 차단) */
@Entity({ name: 'tb_admin_audit_log' })
export class AdminAuditLog extends CreatedAtEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  adminAuditLogId: string;

  /** admin 레포의 관리자 ID (X-Admin-Actor-Id) */
  @Column({ name: 'actor_id', type: 'varchar', length: 100 })
  actorId: string;

  @Column({ name: 'actor_name', type: 'varchar', length: 100, nullable: true })
  actorName: string | null;

  @Column({ name: 'action', type: 'varchar', length: 50 })
  action: AdminAuditAction;

  /** SERVICE / API_KEY / PG_CREDENTIAL / PRODUCT_TYPE / PAYMENT / WEBHOOK_DELIVERY ... */
  @Column({ name: 'target_type', type: 'varchar', length: 30 })
  targetType: string;

  @Column({ name: 'target_id', type: 'varchar', length: 100 })
  targetId: string;

  /** 대상이 속한 서비스 */
  @Column({ name: 'service_id', type: 'uuid', nullable: true })
  serviceId: string | null;

  /** 변경 전 (비밀값 제외) */
  @Column({ name: 'before', type: 'jsonb', nullable: true })
  before: Record<string, unknown> | null;

  /** 변경 후 (비밀값 제외) */
  @Column({ name: 'after', type: 'jsonb', nullable: true })
  after: Record<string, unknown> | null;

  /** 수동 환불·정지 등 사유 */
  @Column({ name: 'reason', type: 'varchar', length: 200, nullable: true })
  reason: string | null;

  @Column({ name: 'request_id', type: 'varchar', length: 100, nullable: true })
  requestId: string | null;

  @Column({ name: 'ip', type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  /** 영향이 큰 작업(REASON_REQUIRED_ACTIONS)은 사유가 없으면 거부한다 */
  static record(params: {
    actor: AdminActor;
    action: AdminAuditAction;
    targetType: string;
    targetId: string;
    serviceId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    reason?: string | null;
  }): AdminAuditLog {
    const reason = params.reason?.trim() || null;
    if (REASON_REQUIRED_ACTIONS.has(params.action) && !reason) {
      throw new BusinessException(ErrorCode.ADMIN_REASON_REQUIRED);
    }

    const log = new AdminAuditLog();
    log.actorId = params.actor.actorId;
    log.actorName = params.actor.actorName;
    log.requestId = params.actor.requestId;
    log.ip = params.actor.ip;
    log.action = params.action;
    log.targetType = params.targetType;
    log.targetId = params.targetId;
    log.serviceId = params.serviceId ?? null;
    log.before = params.before ?? null;
    log.after = params.after ?? null;
    log.reason = reason;
    return log;
  }
}
