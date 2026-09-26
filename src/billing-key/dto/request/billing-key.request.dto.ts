import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { ValidationMessage } from '../../../common/utils/validation-message.util';

export class IssueBillingKeyRequestDto {
  @ApiProperty({ description: '서비스 쪽 사용자 ID', example: 'user-123' })
  @IsString({ message: ValidationMessage.string('externalUserId') })
  @IsNotEmpty({ message: ValidationMessage.required('externalUserId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('externalUserId', 100) })
  externalUserId: string;

  @ApiProperty({
    description: '토스 customerKey. 서비스가 사용자별로 만든 추측 불가능한 값 (카드 등록창에 넘긴 값과 같아야 함)',
    example: 'c_8f2a91d0e4',
  })
  @IsString({ message: ValidationMessage.string('customerKey') })
  @Matches(/^[A-Za-z0-9\-_=.@]{2,300}$/, {
    message: ValidationMessage.format('customerKey', '영문·숫자·-_=.@ 2~300자'),
  })
  customerKey: string;

  @ApiProperty({ description: '토스 카드 등록창 successUrl로 받은 authKey', example: 'bln_...' })
  @IsString({ message: ValidationMessage.string('authKey') })
  @IsNotEmpty({ message: ValidationMessage.required('authKey') })
  @MaxLength(300, { message: ValidationMessage.maxLength('authKey', 300) })
  authKey: string;
}

export class ListBillingKeysQueryDto {
  @ApiProperty({ description: '서비스 쪽 사용자 ID (필수)', example: 'user-123' })
  @IsString({ message: ValidationMessage.string('externalUserId') })
  @IsNotEmpty({ message: ValidationMessage.required('externalUserId') })
  @MaxLength(100, { message: ValidationMessage.maxLength('externalUserId', 100) })
  externalUserId: string;
}
