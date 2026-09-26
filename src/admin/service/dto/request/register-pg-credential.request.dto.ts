import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ValidationMessage } from '../../../../common/utils/validation-message.util';
import { PgEnvironment } from '../../../../service/constants/service.constants';

export class RegisterPgCredentialRequestDto {
  @ApiProperty({ description: 'PG 환경. 키 prefix(test_ / live_)와 일치해야 함', enum: Object.values(PgEnvironment) })
  @IsIn(Object.values(PgEnvironment), {
    message: ValidationMessage.oneOf('environment', Object.values(PgEnvironment)),
  })
  environment: PgEnvironment;

  @ApiPropertyOptional({ description: '토스 상점 ID (mId)', example: 'tosspayments', maxLength: 100 })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('merchantId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('merchantId', 100) })
  merchantId?: string;

  @ApiProperty({ description: '토스 클라이언트 키 (공개 값, 결제창용)', example: 'live_ck_...', maxLength: 200 })
  @IsString({ message: ValidationMessage.string('clientKey') })
  @IsNotEmpty({ message: ValidationMessage.required('clientKey') })
  @MaxLength(200, { message: ValidationMessage.maxLength('clientKey', 200) })
  clientKey: string;

  @ApiProperty({
    description: '토스 시크릿 키. 암호화 저장되며 어떤 응답에도 다시 나오지 않음',
    example: 'live_sk_...',
    maxLength: 200,
  })
  @IsString({ message: ValidationMessage.string('secretKey') })
  @IsNotEmpty({ message: ValidationMessage.required('secretKey') })
  @MaxLength(200, { message: ValidationMessage.maxLength('secretKey', 200) })
  secretKey: string;
}
