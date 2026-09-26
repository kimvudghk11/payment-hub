import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminApi } from '../../common/decorators/auth.decorator';
import { CurrentAdminActor } from '../../common/decorators/current-actor.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { IPageable } from '../../common/interceptors/response.interceptor';
import { AdminActor } from '../../common/types/request-context';
import {
  AdminPaymentPageResponseDto,
  AdminPaymentResponseDto,
  AdminWebhookDeliveryResponseDto,
} from '../payment/dto/response/admin-payment.response.dto';
import { AdminReasonRequestDto } from '../service/dto/request/admin-reason.request.dto';
import { AdminOpsService } from './admin-ops.service';
import { ListUnknownPaymentsQueryDto, ListWebhookDeliveriesQueryDto } from './dto/request/admin-ops.query.dto';

class AdminWebhookDeliveryPageResponseDto {
  @ApiProperty({ type: [AdminWebhookDeliveryResponseDto] })
  data: AdminWebhookDeliveryResponseDto[];

  @ApiProperty({ description: '필터에 맞는 전체 개수' })
  totalCount: number;

  @ApiProperty({ description: '다음 페이지 cursor. 마지막이면 null', nullable: true, type: String })
  nextCursor: string | null;
}

class AdminReconcileResponseDto {
  @ApiProperty({ description: '이번 요청으로 확정했으면 true. 토스도 아직 모르거나 이미 확정된 결제면 false' })
  resolved: boolean;

  @ApiProperty({ type: AdminPaymentResponseDto })
  payment: AdminPaymentResponseDto;
}

@ApiTags('관리자 API — 운영')
@ApiBearerAuth('admin-api-key')
@ApiHeader({ name: 'X-Admin-Actor-Id', required: true, description: '작업한 관리자 ID' })
@AdminApi()
@Controller('admin/ops')
export class AdminOpsController {
  constructor(private readonly opsService: AdminOpsService) {}

  @Get('webhook-deliveries')
  @ApiOperation({ summary: '웹훅 전달 내역', description: '실패 큐는 status=DEAD. 서비스별, 최신순 cursor 페이징' })
  @ResponseMessage('웹훅 전달 내역을 조회했습니다.')
  @ApiResponse({ status: 200, type: AdminWebhookDeliveryPageResponseDto })
  async listWebhookDeliveries(
    @Query() query: ListWebhookDeliveriesQueryDto,
  ): Promise<IPageable<AdminWebhookDeliveryResponseDto>> {
    const page = await this.opsService.listWebhookDeliveries(query);
    return {
      ...page,
      data: page.data.map(({ delivery, event }) => AdminWebhookDeliveryResponseDto.from(delivery, event)),
    };
  }

  @Post('webhook-deliveries/:deliveryId/redeliver')
  @HttpCode(200)
  @ApiOperation({
    summary: '웹훅 재전송',
    description:
      'PENDING으로 돌려 바로 보낸다. 받는 곳은 서비스의 현재 webhookUrl, 시도 횟수는 유지 (또 실패하면 다시 DEAD). 이미 대기·전송 중이면 그대로 200',
  })
  @ResponseMessage('웹훅 재전송을 예약했습니다.')
  @ApiResponse({ status: 200, type: AdminWebhookDeliveryResponseDto })
  async redeliver(
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @Body() dto: AdminReasonRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<AdminWebhookDeliveryResponseDto> {
    const { delivery, event } = await this.opsService.redeliver(deliveryId, actor, dto.reason);
    return AdminWebhookDeliveryResponseDto.from(delivery, event);
  }

  @Get('unknown-payments')
  @ApiOperation({
    summary: '대사 대기 결제',
    description: 'IN_PROGRESS·UNKNOWN 결제, 오래된 순. 대사 배치가 오래 확정하지 못한 건을 사람이 본다',
  })
  @ResponseMessage('대사 대기 결제를 조회했습니다.')
  @ApiResponse({ status: 200, type: AdminPaymentPageResponseDto })
  async listUnknownPayments(@Query() query: ListUnknownPaymentsQueryDto): Promise<IPageable<AdminPaymentResponseDto>> {
    const page = await this.opsService.listUnknownPayments(query);
    return { ...page, data: page.data.map(({ payment, order }) => AdminPaymentResponseDto.fromAdmin(payment, order)) };
  }

  @Post('payments/:paymentId/reconcile')
  @HttpCode(200)
  @ApiOperation({
    summary: '수동 대사',
    description: '토스 조회로 지금 확정한다 (배치의 2분 대기 없이). 확정했을 때만 감사 로그',
  })
  @ResponseMessage('대사를 실행했습니다.')
  @ApiResponse({ status: 200, type: AdminReconcileResponseDto })
  async reconcile(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: AdminReasonRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<AdminReconcileResponseDto> {
    const { resolved, payment, order } = await this.opsService.reconcile(paymentId, actor, dto.reason);
    return Object.assign(new AdminReconcileResponseDto(), {
      resolved,
      payment: AdminPaymentResponseDto.fromAdmin(payment, order),
    });
  }
}
