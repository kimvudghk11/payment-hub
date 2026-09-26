import { decodeCursor, encodeCursor } from '../../src/common/utils/cursor.util';
import { expectBusinessError } from '../support/business-error';

describe('cursor 페이징', () => {
  const createdAt = new Date('2026-09-26T07:15:22.323Z');
  const id = '0b6f3c1e-2d4a-4b8e-9f10-123456789abc';

  it('(createdAt, id)를 불투명 문자열로 인코딩하고 그대로 복원한다', () => {
    const cursor = encodeCursor({ createdAt, id });

    expect(cursor).not.toContain(id);
    expect(decodeCursor(cursor)).toEqual({ createdAt, id });
  });

  it('형식이 깨진 cursor는 400 INVALID_REQUEST', () => {
    for (const broken of ['not-base64!!', Buffer.from('{"a":1}').toString('base64url'), '']) {
      expectBusinessError(() => decodeCursor(broken), 'INVALID_REQUEST');
    }
  });
});
