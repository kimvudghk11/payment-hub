import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ValidationMessage } from '../../../../common/utils/validation-message.util';
import { ProductTypeUpdate } from '../../../../service/domain/service-product-type.entity';

const PRODUCT_TYPE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,49}$/;

export class CreateProductTypeRequestDto {
  @ApiProperty({ description: '상품 유형 코드. 영문 대문자로 시작, 대문자·숫자·_ 1~50자', example: 'PLAN' })
  @Matches(PRODUCT_TYPE_CODE_PATTERN, {
    message: ValidationMessage.format('code', '영문 대문자로 시작, 대문자·숫자·_ 1~50자'),
  })
  code: string;

  @ApiProperty({ description: '표시 이름', example: '구독 요금제', maxLength: 100 })
  @IsString({ message: ValidationMessage.string('name') })
  @IsNotEmpty({ message: ValidationMessage.required('name') })
  @MaxLength(100, { message: ValidationMessage.maxLength('name', 100) })
  name: string;
}

export class UpdateProductTypeRequestDto {
  @ApiPropertyOptional({ description: '표시 이름', example: '구독 요금제', maxLength: 100 })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('name') })
  @IsNotEmpty({ message: ValidationMessage.required('name') })
  @MaxLength(100, { message: ValidationMessage.maxLength('name', 100) })
  name?: string;

  @ApiPropertyOptional({ description: 'false = 중지 (새 주문에 사용 불가), true = 재개', example: false })
  @IsOptional()
  @IsBoolean({ message: ValidationMessage.boolean('isActive') })
  isActive?: boolean;

  toUpdate(): ProductTypeUpdate {
    return { name: this.name, isActive: this.isActive };
  }
}

export class ListProductTypesQueryDto {
  @ApiPropertyOptional({ description: '활성 여부 필터' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean({ message: ValidationMessage.boolean('isActive') })
  isActive?: boolean;
}
