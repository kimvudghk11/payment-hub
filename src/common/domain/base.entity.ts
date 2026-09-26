import { UpdateDateColumn } from 'typeorm';
import { CreatedAtEntity } from './created-at.entity';

/** created_at + updated_at이 있는 테이블의 베이스. updated_at은 DB 트리거(fn_set_updated_at)도 갱신한다. */
export abstract class BaseEntity extends CreatedAtEntity {
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
