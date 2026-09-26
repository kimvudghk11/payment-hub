import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import '../types/request-context';
import { AdminActor } from '../types/request-context';

/** @AdminApi 핸들러에서 인증된 관리자. 가드를 거치지 않았으면 서버 버그이므로 예외 */
export const CurrentAdminActor = createParamDecorator((_: unknown, context: ExecutionContext): AdminActor => {
  const actor = context.switchToHttp().getRequest<Request>().adminActor;
  if (!actor) throw new Error('adminActor가 없습니다. @AdminApi()가 붙었는지 확인하세요.');
  return actor;
});

/** @ServiceApi 핸들러에서 인증된 서비스 ID. 모든 쿼리 조건에 반드시 넣는다 */
export const CurrentServiceId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const serviceId = context.switchToHttp().getRequest<Request>().serviceId;
  if (!serviceId) throw new Error('serviceId가 없습니다. @ServiceApi()가 붙었는지 확인하세요.');
  return serviceId;
});
