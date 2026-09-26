import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ValidationMessage } from '../../../../common/utils/validation-message.util';
import { ListPaymentsQueryDto } from '../../../../payment/dto/request/list-payments.query.dto';

/** 전 서비스 결제 검색. 서비스 API 필터 + 서비스·카드사·토스 paymentKey */
export class AdminListPaymentsQueryDto extends ListPaymentsQueryDto {
  @ApiPropertyOptional({ description: '서비스 ID' })
  @IsOptional()
  @IsUUID('all', { message: ValidationMessage.uuid('serviceId') })
  serviceId?: string;

  @ApiPropertyOptional({ description: '토스 카드사 코드 (issuerCode)', example: '11' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('cardCompanyCode') })
  @MaxLength(10, { message: ValidationMessage.maxLength('cardCompanyCode', 10) })
  cardCompanyCode?: string;

  @ApiPropertyOptional({ description: '토스 paymentKey (토스 대시보드·CS 문의에서 넘어온 키)' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('paymentKey') })
  @MaxLength(200, { message: ValidationMessage.maxLength('paymentKey', 200) })
  paymentKey?: string;
}
