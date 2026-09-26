import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';
import { ValidationMessage } from '../../../../common/utils/validation-message.util';

export const SERVICE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,19}$/;
export const HTTPS_URL_OPTIONS = { protocols: ['https'], require_protocol: true };

export class CreateServiceRequestDto {
  @ApiProperty({ description: '서비스 코드. 영문 대문자로 시작, 대문자·숫자·_ 2~20자, 전역 유일', example: 'SVC_A' })
  @Matches(SERVICE_CODE_PATTERN, {
    message: ValidationMessage.format('code', '영문 대문자로 시작, 대문자·숫자·_ 2~20자'),
  })
  code: string;

  @ApiProperty({ description: '서비스 이름', example: '서비스 A', maxLength: 100 })
  @IsString({ message: ValidationMessage.string('name') })
  @IsNotEmpty({ message: ValidationMessage.required('name') })
  @MaxLength(100, { message: ValidationMessage.maxLength('name', 100) })
  name: string;

  @ApiPropertyOptional({
    description: '결제 이벤트를 받을 https URL. 없으면 웹훅을 보내지 않음',
    example: 'https://svc-a.example.com/webhooks/payment-hub',
  })
  @IsOptional()
  @IsUrl(HTTPS_URL_OPTIONS, { message: ValidationMessage.httpsUrl('webhookUrl') })
  webhookUrl?: string;
}
