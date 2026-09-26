import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ServiceApi } from '../common/decorators/auth.decorator';
import { CurrentServiceId } from '../common/decorators/current-actor.decorator';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { IPageable } from '../common/interceptors/response.interceptor';
import { ConfirmPaymentRequestDto } from './dto/request/confirm-payment.request.dto';
import { ListPaymentsQueryDto } from './dto/request/list-payments.query.dto';
import { PaymentPageResponseDto, PaymentResponseDto } from './dto/response/payment.response.dto';
import { RefundableResponseDto } from './dto/response/refundable.response.dto';
import { PaymentService } from './payment.service';

@ApiTags('서비스 API — 결제')
@ApiBearerAuth('service-api-key')
@ServiceApi()
@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '결제 승인',
    description:
      '토스 결제창 인증 후 successUrl로 받은 paymentKey·orderId·amount로 승인한다. 같은 paymentKey 재요청은 기록된 결과를 준다. ' +
      '402 PAYMENT_REJECTED = 토스 거절(detail.pgCode·pgMessage), 504 PG_TIMEOUT·502 PG_ERROR = 결과 불명(UNKNOWN) — 재시도하지 말고 조회·웹훅으로 확인',
  })
  @ResponseMessage('결제가 승인되었습니다.')
  @ApiResponse({ status: 200, description: 'DONE 또는 가상계좌 WAITING_FOR_DEPOSIT', type: PaymentResponseDto })
  async confirm(
    @CurrentServiceId() serviceId: string,
    @Body() dto: ConfirmPaymentRequestDto,
  ): Promise<PaymentResponseDto> {
    const { payment, order } = await this.paymentService.confirm({ serviceId, ...dto });
    return PaymentResponseDto.from(payment, order);
  }

  @Get()
  @ApiOperation({
    summary: '결제 목록',
    description:
      '자기 서비스 결제만. externalUserId(사용자별 이력)·externalOrderId·externalSubscriptionId·상태(쉼표 여러 개)·수단·기간 필터, 최신순 cursor 페이징. 실패한 시도도 포함',
  })
  @ResponseMessage('결제 목록을 조회했습니다.')
  @ApiResponse({ status: 200, type: PaymentPageResponseDto })
  async list(
    @CurrentServiceId() serviceId: string,
    @Query() query: ListPaymentsQueryDto,
  ): Promise<IPageable<PaymentResponseDto>> {
    const page = await this.paymentService.list(serviceId, query);
    return { ...page, data: page.data.map(({ payment, order }) => PaymentResponseDto.from(payment, order)) };
  }

  @Get(':paymentId/refundable')
  @ApiOperation({
    summary: '환불 가능 금액',
    description: '환불 요청 amount의 상한과 항목별 취소 가능 수량. 승인되지 않은 결제는 0',
  })
  @ResponseMessage('환불 가능 금액을 조회했습니다.')
  @ApiResponse({ status: 200, type: RefundableResponseDto })
  async refundable(
    @CurrentServiceId() serviceId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<RefundableResponseDto> {
    const { payment, items } = await this.paymentService.getRefundable(serviceId, paymentId);
    return RefundableResponseDto.from(payment, items);
  }

  @Get(':paymentId')
  @ApiOperation({
    summary: '결제 단건',
    description: '결제 수단 분류·환불 가능 금액 포함. 다른 서비스의 결제는 404 PAYMENT_NOT_FOUND',
  })
  @ResponseMessage('결제를 조회했습니다.')
  @ApiResponse({ status: 200, type: PaymentResponseDto })
  async get(
    @CurrentServiceId() serviceId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<PaymentResponseDto> {
    const { payment, order } = await this.paymentService.get(serviceId, paymentId);
    return PaymentResponseDto.from(payment, order);
  }
}
