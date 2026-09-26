import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-code';

/** 목록 정렬 키 `(created_at DESC, id DESC)`의 마지막 위치 */
export interface CursorPosition {
  createdAt: Date;
  id: string;
}

export const encodeCursor = ({ createdAt, id }: CursorPosition): string =>
  Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: id })).toString('base64url');

export const decodeCursor = (cursor: string): CursorPosition => {
  try {
    const { c, i } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
    const createdAt = new Date(typeof c === 'string' ? c : NaN);
    if (typeof i !== 'string' || Number.isNaN(createdAt.getTime())) throw new Error('invalid cursor');
    return { createdAt, id: i };
  } catch {
    throw new BusinessException(ErrorCode.INVALID_REQUEST, {
      errors: [{ field: 'cursor', message: 'cursor 형식이 올바르지 않습니다.' }],
    });
  }
};
