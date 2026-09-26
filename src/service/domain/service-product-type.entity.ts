import { Column, Entity, PrimaryColumn } from 'typeorm';
import { BaseEntity } from '../../common/domain/base.entity';

export interface ProductTypeUpdate {
  name?: string;
  isActive?: boolean;
}

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

  static create(params: { serviceId: string; code: string; name: string }): ServiceProductType {
    const productType = new ServiceProductType();
    productType.serviceId = params.serviceId;
    productType.code = params.code;
    productType.name = params.name;
    productType.isActive = true;
    return productType;
  }

  /**
   * 이름 변경, 중지(isActive=false), 재개(isActive=true).
   * 삭제는 없다 — 기존 주문 항목이 FK로 참조하므로 중지된 유형은 새 주문에만 쓸 수 없다.
   * @returns 실제로 바뀐 필드 이름
   */
  update(changes: ProductTypeUpdate): (keyof ProductTypeUpdate)[] {
    const changed: (keyof ProductTypeUpdate)[] = [];
    if (changes.name !== undefined && changes.name !== this.name) {
      this.name = changes.name;
      changed.push('name');
    }
    if (changes.isActive !== undefined && changes.isActive !== this.isActive) {
      this.isActive = changes.isActive;
      changed.push('isActive');
    }
    return changed;
  }

  auditSnapshot(): Record<string, unknown> {
    return { code: this.code, name: this.name, isActive: this.isActive };
  }
}
