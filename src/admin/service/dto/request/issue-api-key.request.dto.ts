import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ValidationMessage } from '../../../../common/utils/validation-message.util';

export class IssueApiKeyRequestDto {
  @ApiProperty({ description: '키 용도 표시', example: 'prod-server-1', maxLength: 50 })
  @IsString({ message: ValidationMessage.string('label') })
  @IsNotEmpty({ message: ValidationMessage.required('label') })
  @MaxLength(50, { message: ValidationMessage.maxLength('label', 50) })
  label: string;

  @ApiPropertyOptional({ description: '만료 시각. 없으면 만료 없음', example: '2027-09-26T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: ValidationMessage.dateString('expiresAt') })
  expiresAt?: string;
}
