import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength, ValidateIf } from 'class-validator';
import { ValidationMessage } from '../../../../common/utils/validation-message.util';
import { ServiceUpdate } from '../../../../service/domain/service.entity';
import { WEBHOOK_URL_OPTIONS } from './create-service.request.dto';

export class UpdateServiceRequestDto {
  @ApiPropertyOptional({ description: '서비스 이름', example: '서비스 A', maxLength: 100 })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('name') })
  @IsNotEmpty({ message: ValidationMessage.required('name') })
  @MaxLength(100, { message: ValidationMessage.maxLength('name', 100) })
  name?: string;

  @ApiPropertyOptional({
    description: '웹훅 URL. null이면 웹훅 전송 중지',
    example: 'https://svc-a.example.com/webhooks/payment-hub',
    nullable: true,
    type: String,
  })
  @ValidateIf((dto: UpdateServiceRequestDto) => dto.webhookUrl !== undefined && dto.webhookUrl !== null)
  @IsUrl(WEBHOOK_URL_OPTIONS, { message: ValidationMessage.httpUrl('webhookUrl') })
  webhookUrl?: string | null;

  toUpdate(): ServiceUpdate {
    return { name: this.name, webhookUrl: this.webhookUrl };
  }
}
