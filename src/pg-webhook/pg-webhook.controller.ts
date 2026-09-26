import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/auth.decorator';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { PgWebhookOutcome, PgWebhookService } from './pg-webhook.service';

class PgWebhookResponseDto {
  @ApiProperty({ description: '처리 결과', enum: ['PROCESSED', 'IGNORED', 'FAILED', 'DUPLICATE'] })
  result: PgWebhookOutcome;
}

/**
 * 토스 → hub 웹훅 수신 (토스 개발자센터에 등록하는 URL).
 * 인증 헤더를 보낼 수 없어 @Public — 대신 페이로드를 믿지 않고 토스 조회로 재확인한다.
 */
@ApiTags('토스 웹훅 수신')
@Public()
@Controller('pg-webhooks')
export class PgWebhookController {
  constructor(private readonly pgWebhookService: PgWebhookService) {}

  @Post('toss')
  @HttpCode(200)
  @ApiOperation({
    summary: '토스 웹훅 수신',
    description:
      '가상계좌 입금(DEPOSIT_CALLBACK)·결제 상태 변경(PAYMENT_STATUS_CHANGED). 페이로드는 신호로만 쓰고 토스 조회로 재확인해 반영. 항상 200',
  })
  @ResponseMessage('웹훅을 수신했습니다.')
  @ApiResponse({ status: 200, type: PgWebhookResponseDto })
  async toss(@Body() body: Record<string, unknown>): Promise<PgWebhookResponseDto> {
    return Object.assign(new PgWebhookResponseDto(), { result: await this.pgWebhookService.receiveToss(body) });
  }
}
