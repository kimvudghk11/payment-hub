import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ValidationMessage } from '../../../../common/utils/validation-message.util';

/**
 * 관리 작업 사유. 정지·삭제처럼 영향이 큰 작업은 사유가 없으면 400 ADMIN_REASON_REQUIRED
 * (필수 여부는 감사 로그 도메인이 판단하므로 DTO에서는 선택으로 둔다)
 */
export class AdminReasonRequestDto {
  @ApiPropertyOptional({ description: '작업 사유 (감사 로그에 기록)', example: '결제 이상 거래 조사', maxLength: 200 })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('reason') })
  @MaxLength(200, { message: ValidationMessage.maxLength('reason', 200) })
  reason?: string;
}
