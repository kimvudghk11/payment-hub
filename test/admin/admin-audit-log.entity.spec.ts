import { AdminAuditAction } from '../../src/admin/audit/constants/admin-audit.constants';
import { AdminAuditLog } from '../../src/admin/audit/domain/admin-audit-log.entity';
import { expectBusinessError } from '../support/business-error';

const actor = { actorId: 'admin-7', actorName: '홍길동', requestId: 'req-1', ip: '10.0.0.1' };

describe('AdminAuditLog.record', () => {
  it('관리자·대상·변경 전후를 담은 감사 로그를 만든다', () => {
    const log = AdminAuditLog.record({
      actor,
      action: AdminAuditAction.SERVICE_SUSPENDED,
      targetType: 'SERVICE',
      targetId: 'svc-1',
      serviceId: 'svc-1',
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED' },
      reason: '이상 거래 조사',
    });

    expect(log).toMatchObject({
      actorId: 'admin-7',
      actorName: '홍길동',
      requestId: 'req-1',
      ip: '10.0.0.1',
      action: 'SERVICE_SUSPENDED',
      targetType: 'SERVICE',
      targetId: 'svc-1',
      serviceId: 'svc-1',
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED' },
      reason: '이상 거래 조사',
    });
  });

  it('선택 값은 null로 채운다', () => {
    const log = AdminAuditLog.record({
      actor,
      action: AdminAuditAction.SERVICE_CREATED,
      targetType: 'SERVICE',
      targetId: 'svc-1',
    });

    expect(log).toMatchObject({ serviceId: null, before: null, after: null, reason: null });
  });

  it('사유가 필요한 작업에 사유가 없으면 400 ADMIN_REASON_REQUIRED', () => {
    for (const reason of [undefined, '', '   ']) {
      expectBusinessError(
        () =>
          AdminAuditLog.record({
            actor,
            action: AdminAuditAction.SERVICE_SUSPENDED,
            targetType: 'SERVICE',
            targetId: 'svc-1',
            reason,
          }),
        'ADMIN_REASON_REQUIRED',
      );
    }
  });
});
