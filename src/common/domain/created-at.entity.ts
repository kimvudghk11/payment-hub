import { CreateDateColumn } from 'typeorm';

/** created_at만 있는 테이블(API 키, 원장, 감사 로그 등)의 베이스. */
export abstract class CreatedAtEntity {
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
