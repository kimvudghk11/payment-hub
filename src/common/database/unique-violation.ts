import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

/** 특정 유니크 제약 위반인지 확인한다 (사전 조회 후에도 동시 요청으로 생길 수 있는 경합 처리용) */
export const isUniqueViolation = (error: unknown, constraint: string): boolean => {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as { code?: string; constraint?: string };
  return driverError.code === PG_UNIQUE_VIOLATION && driverError.constraint === constraint;
};
