import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ValidationMessage } from '../../../../common/utils/validation-message.util';
import { CancelRequestedBy } from '../../../../payment/constants/payment.constants';
import { CancelRequest } from '../../../../payment/domain/payment.entity';
import { CancelPaymentRequestDto } from '../../../../payment/dto/request/cancel-payment.request.dto';

/** admin 멱등키 접두사 — 서비스가 정한 환불 멱등키와 같은 문자열이어도 섞이지 않게 */
export const ADMIN_IDEMPOTENCY_PREFIX = 'admin:';

/**
 * 관리자 수동 환불. 서비스 환불과 같은 필드 + 사유(reason).
 * 사유 필수 여부는 감사 로그 도메인(PAYMENT_CANCELED_BY_ADMIN)이 판단한다 → 없으면 400 ADMIN_REASON_REQUIRED.
 */
export class AdminCancelPaymentRequestDto extends CancelPaymentRequestDto {
  @ApiPropertyOptional({
    description: '환불 사유 (필수 — 감사 로그, 토스 취소 사유)',
    example: 'CS 문의 — 중복 결제 환불',
  })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('reason') })
  @MaxLength(200, { message: ValidationMessage.maxLength('reason', 200) })
  reason?: string;

  @ApiProperty({ description: '멱등키 (admin 화면의 요청 ID 등, 최대 90자)', example: 'cs-ticket-4821' })
  @MaxLength(90, { message: ValidationMessage.maxLength('idempotencyKey', 90) })
  declare idempotencyKey: string;

  toAdminRequest(): CancelRequest {
    return {
      ...this.toRequest(),
      idempotencyKey: `${ADMIN_IDEMPOTENCY_PREFIX}${this.idempotencyKey}`,
      reasonDetail: this.reasonDetail ?? this.reason ?? null,
      requestedBy: CancelRequestedBy.ADMIN,
    };
  }
}
