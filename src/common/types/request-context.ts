/** 인증된 관리자. 헤더 값은 admin 레포가 인증했다고 신뢰한다 (CLAUDE.md 6.1) */
export interface AdminActor {
  actorId: string;
  actorName: string | null;
  requestId: string | null;
  ip: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** @ServiceApi 인증 후 ApiKeyGuard가 채운다. 모든 조회·쓰기 쿼리에 조건으로 강제 */
    serviceId?: string;
    /** @AdminApi 인증 후 AdminGuard가 채운다. 감사 로그 actor */
    adminActor?: AdminActor;
  }
}
