import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ServiceApi } from '../common/decorators/auth.decorator';
import { CurrentServiceId } from '../common/decorators/current-actor.decorator';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { IPageable } from '../common/interceptors/response.interceptor';
import { CreateOrderRequestDto } from './dto/request/create-order.request.dto';
import { ListOrdersQueryDto } from './dto/request/list-orders.query.dto';
import { OrderPageResponseDto, OrderResponseDto, OrderSummaryResponseDto } from './dto/response/order.response.dto';
import { OrderService } from './order.service';

@ApiTags('서비스 API — 주문')
@ApiBearerAuth('service-api-key')
@ServiceApi()
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  @ApiOperation({
    summary: '주문 등록',
    description:
      '결제 전에 서비스 서버가 주문을 등록해 금액을 고정한다. 같은 externalOrderId·같은 내용이면 기존 주문을 200으로, 내용이 다르면 409',
  })
  @ResponseMessage('주문이 등록되었습니다.')
  @ApiResponse({ status: 201, description: '새로 등록', type: OrderResponseDto })
  @ApiResponse({ status: 200, description: '같은 요청 재시도 — 기존 주문', type: OrderResponseDto })
  async create(
    @CurrentServiceId() serviceId: string,
    @Body() dto: CreateOrderRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponseDto> {
    const { order, created } = await this.orderService.create(dto.toParams(serviceId, new Date()));
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return OrderResponseDto.from(order);
  }

  @Get()
  @ApiOperation({
    summary: '주문 목록',
    description:
      '자기 서비스 주문만. externalOrderId·externalUserId·externalSubscriptionId·상태·기간 필터, 최신순 cursor 페이징',
  })
  @ResponseMessage('주문 목록을 조회했습니다.')
  @ApiResponse({ status: 200, type: OrderPageResponseDto })
  async list(
    @CurrentServiceId() serviceId: string,
    @Query() query: ListOrdersQueryDto,
  ): Promise<IPageable<OrderSummaryResponseDto>> {
    const page = await this.orderService.list(serviceId, query);
    return { ...page, data: page.data.map((order) => OrderSummaryResponseDto.from(order)) };
  }

  @Get(':orderId')
  @ApiOperation({ summary: '주문 단건', description: '항목 포함. 다른 서비스의 주문은 404 ORDER_NOT_FOUND' })
  @ResponseMessage('주문을 조회했습니다.')
  @ApiResponse({ status: 200, type: OrderResponseDto })
  async get(
    @CurrentServiceId() serviceId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.from(await this.orderService.get(serviceId, orderId));
  }
}
