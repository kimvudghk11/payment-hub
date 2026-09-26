import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminApi } from '../../common/decorators/auth.decorator';
import { CurrentAdminActor } from '../../common/decorators/current-actor.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AdminActor } from '../../common/types/request-context';
import { IPageable } from '../../common/interceptors/response.interceptor';
import { OrderResponseDto } from '../../order/dto/response/order.response.dto';
import { PaymentCancelResponseDto } from '../../payment/dto/response/payment-cancel.response.dto';
import { AdminPaymentService } from './admin-payment.service';
import { AdminCancelPaymentRequestDto } from './dto/request/admin-cancel-payment.request.dto';
import { AdminListPaymentsQueryDto } from './dto/request/admin-list-payments.query.dto';
import {
  AdminLedgerTransactionResponseDto,
  AdminPaymentDetailResponseDto,
  AdminPaymentPageResponseDto,
  AdminPaymentResponseDto,
  AdminWebhookDeliveryResponseDto,
} from './dto/response/admin-payment.response.dto';

class AdminCancelPaymentResponseDto {
  @ApiProperty({ type: PaymentCancelResponseDto })
  cancel: PaymentCancelResponseDto;

  @ApiProperty({ type: AdminPaymentResponseDto })
  payment: AdminPaymentResponseDto;
}

@ApiTags('관리자 API — 결제')
@ApiBearerAuth('admin-api-key')
@ApiHeader({ name: 'X-Admin-Actor-Id', required: true, description: '작업한 관리자 ID' })
@AdminApi()
@Controller('admin/payments')
export class AdminPaymentController {
  constructor(private readonly adminPaymentService: AdminPaymentService) {}

  @Get()
  @ApiOperation({
    summary: '전 서비스 결제 검색',
    description:
      '서비스·상태(쉼표 여러 개)·수단·카드사·기간·사용자·서비스 주문번호·토스 paymentKey 필터, 최신순 cursor 페이징',
  })
  @ResponseMessage('결제 목록을 조회했습니다.')
  @ApiResponse({ status: 200, type: AdminPaymentPageResponseDto })
  async list(@Query() query: AdminListPaymentsQueryDto): Promise<IPageable<AdminPaymentResponseDto>> {
    const page = await this.adminPaymentService.list(query);
    return { ...page, data: page.data.map(({ payment, order }) => AdminPaymentResponseDto.fromAdmin(payment, order)) };
  }

  @Get(':paymentId')
  @ApiOperation({
    summary: '결제 상세',
    description: '주문·항목, 취소 이력, 원장 분개, 웹훅 전달 내역, PG 응답 원본을 한 번에',
  })
  @ResponseMessage('결제를 조회했습니다.')
  @ApiResponse({ status: 200, type: AdminPaymentDetailResponseDto })
  async detail(@Param('paymentId', ParseUUIDPipe) paymentId: string): Promise<AdminPaymentDetailResponseDto> {
    const detail = await this.adminPaymentService.detail(paymentId);
    const { payment, order } = detail;
    return Object.assign(new AdminPaymentDetailResponseDto(), AdminPaymentResponseDto.fromAdmin(payment, order), {
      order: OrderResponseDto.from(order),
      cancels: [...payment.cancels]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((cancel) => PaymentCancelResponseDto.from(cancel)),
      ledger: detail.ledger.map((tx) => AdminLedgerTransactionResponseDto.from(tx, detail.ledgerAccountCodes)),
      webhookDeliveries: detail.webhookDeliveries.map(({ delivery, event }) =>
        AdminWebhookDeliveryResponseDto.from(delivery, event),
      ),
      providerResponse: payment.providerResponse,
    });
  }

  @Post(':paymentId/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: '수동 환불',
    description:
      '서비스 환불과 같은 규칙(환불 가능 금액 상한·항목·멱등)에 requestedBy=ADMIN. reason 필수(없으면 400 ADMIN_REASON_REQUIRED, 토스 호출 전). ' +
      '감사 로그 PAYMENT_CANCELED_BY_ADMIN. idempotencyKey는 서비스의 환불 멱등키와 섞이지 않는다',
  })
  @ResponseMessage('환불이 완료되었습니다.')
  @ApiResponse({ status: 200, type: AdminCancelPaymentResponseDto })
  async cancel(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: AdminCancelPaymentRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<AdminCancelPaymentResponseDto> {
    const { cancel, payment, order } = await this.adminPaymentService.cancel(paymentId, dto, actor);
    return Object.assign(new AdminCancelPaymentResponseDto(), {
      cancel: PaymentCancelResponseDto.from(cancel),
      payment: AdminPaymentResponseDto.fromAdmin(payment, order),
    });
  }
}
