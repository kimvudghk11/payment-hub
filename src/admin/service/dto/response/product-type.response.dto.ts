import { ApiProperty } from '@nestjs/swagger';
import { ServiceProductType } from '../../../../service/domain/service-product-type.entity';

export class ProductTypeResponseDto {
  @ApiProperty({ description: '서비스 ID', example: '0b6f...' })
  serviceId: string;

  @ApiProperty({ description: '상품 유형 코드', example: 'PLAN' })
  code: string;

  @ApiProperty({ description: '표시 이름', example: '구독 요금제' })
  name: string;

  @ApiProperty({ description: '활성 여부. false면 새 주문에 사용 불가', example: true })
  isActive: boolean;

  @ApiProperty({ description: '등록 시각', example: '2026-09-27T01:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ description: '수정 시각', example: '2026-09-27T01:00:00.000Z' })
  updatedAt: Date;

  static from(productType: ServiceProductType): ProductTypeResponseDto {
    const dto = new ProductTypeResponseDto();
    dto.serviceId = productType.serviceId;
    dto.code = productType.code;
    dto.name = productType.name;
    dto.isActive = productType.isActive;
    dto.createdAt = productType.createdAt;
    dto.updatedAt = productType.updatedAt;
    return dto;
  }
}
