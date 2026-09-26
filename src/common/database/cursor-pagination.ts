import { Brackets, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { IPageable } from '../interceptors/response.interceptor';
import { decodeCursor, encodeCursor } from '../utils/cursor.util';

export const DEFAULT_PAGE_SIZE = 20;

/**
 * (createdAt DESC, id DESC) cursor 페이징. 시각 컬럼이 createdAt이 아닌 테이블은 dateProperty로 지정한다 (예: receivedAt). 필터가 걸린 쿼리를 받아 totalCount와 한 페이지를 돌려준다.
 * offset 대신 cursor를 쓰는 이유: 데이터가 쌓여도 느려지지 않고, 중간 삽입 시 누락·중복이 없다.
 */
export const paginateByCreatedAt = async <T extends ObjectLiteral>(
  filtered: SelectQueryBuilder<T>,
  options: {
    alias: string;
    idProperty: keyof T & string;
    dateProperty?: keyof T & string;
    limit?: number;
    cursor?: string;
  },
): Promise<IPageable<T>> => {
  const { alias, idProperty } = options;
  const dateProperty = options.dateProperty ?? 'createdAt';
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;

  const totalCount = await filtered.clone().getCount();

  const page = filtered.clone();
  if (options.cursor) {
    const { createdAt, id } = decodeCursor(options.cursor);
    page.andWhere(
      new Brackets((qb) =>
        qb
          .where(`${alias}.${dateProperty} < :cursorCreatedAt`, { cursorCreatedAt: createdAt })
          .orWhere(`${alias}.${dateProperty} = :cursorCreatedAt AND ${alias}.${idProperty} < :cursorId`, {
            cursorCreatedAt: createdAt,
            cursorId: id,
          }),
      ),
    );
  }
  const rows = await page
    .orderBy(`${alias}.${dateProperty}`, 'DESC')
    .addOrderBy(`${alias}.${idProperty}`, 'DESC')
    .take(limit + 1)
    .getMany();

  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    data,
    totalCount,
    nextCursor:
      rows.length > limit ? encodeCursor({ createdAt: last[dateProperty], id: String(last[idProperty]) }) : null,
  };
};
