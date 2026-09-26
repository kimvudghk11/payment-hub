import { SetMetadata } from '@nestjs/common';
import '../types/request-context';

export const AUTH_TYPE_KEY = 'authType';

export const AuthType = {
  PUBLIC: 'PUBLIC',
  SERVICE: 'SERVICE',
  ADMIN: 'ADMIN',
} as const;
export type AuthType = (typeof AuthType)[keyof typeof AuthType];

/**
 * 모든 핸들러는 아래 셋 중 하나를 붙인다 (컨트롤러 단위도 가능, 핸들러가 우선).
 * 아무것도 없으면 전역 AuthGuard가 거부한다 (default deny).
 */
export const Public = () => SetMetadata(AUTH_TYPE_KEY, AuthType.PUBLIC);
export const ServiceApi = () => SetMetadata(AUTH_TYPE_KEY, AuthType.SERVICE);
export const AdminApi = () => SetMetadata(AUTH_TYPE_KEY, AuthType.ADMIN);
