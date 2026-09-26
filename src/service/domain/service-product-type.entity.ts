import { Column, Entity, PrimaryColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';

/** 상품 카탈로그가 아닌 "이 서비스가 파는 상품 유형" 화이트리스트. 삭제 대신 is_active=false */
@Entity({ name: 'tb_service_product_type' })
export class ServiceProductType extends BaseEntity {
  @PrimaryColumn({ name: 'service_id', type: 'uuid' })
  serviceId: string;

  /** 'PLAN', 'CREDIT', 'ADDON' ... 서비스가 정의 */
  @PrimaryColumn({ name: 'code', type: 'varchar', length: 50 })
  code: string;

  @Column({ name: 'name', type: 'varchar', length: 100 })
  name: string;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive: boolean;
}
