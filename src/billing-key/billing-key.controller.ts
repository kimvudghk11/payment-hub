import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ServiceApi } from '../common/decorators/auth.decorator';
import { CurrentServiceId } from '../common/decorators/current-actor.decorator';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { IPageable } from '../common/interceptors/response.interceptor';
import { BillingKeyService } from './billing-key.service';
import { IssueBillingKeyRequestDto, ListBillingKeysQueryDto } from './dto/request/billing-key.request.dto';
import { BillingKeyListResponseDto, BillingKeyResponseDto } from './dto/response/billing-key.response.dto';

@ApiTags('서비스 API — 결제 수단(빌링키)')
@ApiBearerAuth('service-api-key')
@ServiceApi()
@Controller('billing-keys')
export class BillingKeyController {
  constructor(private readonly billingKeyService: BillingKeyService) {}

  @Post()
  @ApiOperation({
    summary: '빌링키 등록',
    description:
      '토스 카드 등록창 인증 후 authKey로 빌링키를 발급받아 암호화 저장. 빌링키 원문은 어떤 응답에도 나가지 않는다. 402 BILLING_KEY_REJECTED = 토스 거절',
  })
  @ResponseMessage('결제 수단이 등록되었습니다.')
  @ApiResponse({ status: 201, type: BillingKeyResponseDto })
  async issue(
    @CurrentServiceId() serviceId: string,
    @Body() dto: IssueBillingKeyRequestDto,
  ): Promise<BillingKeyResponseDto> {
    return BillingKeyResponseDto.from(await this.billingKeyService.issue({ serviceId, ...dto }));
  }

  @Get()
  @ApiOperation({ summary: '사용자 결제 수단 목록', description: '활성 수단만, 최근 등록 순. externalUserId 필수' })
  @ResponseMessage('결제 수단 목록을 조회했습니다.')
  @ApiResponse({ status: 200, type: BillingKeyListResponseDto })
  async list(
    @CurrentServiceId() serviceId: string,
    @Query() query: ListBillingKeysQueryDto,
  ): Promise<IPageable<BillingKeyResponseDto>> {
    const keys = await this.billingKeyService.listActive(serviceId, query.externalUserId);
    return { data: keys.map((key) => BillingKeyResponseDto.from(key)), totalCount: keys.length, nextCursor: null };
  }

  @Delete(':billingKeyId')
  @ApiOperation({
    summary: '결제 수단 해제',
    description: 'REVOKED — 이후 자동결제에 쓸 수 없다. 이미 해제됐으면 그대로 200. 다른 서비스의 수단은 404',
  })
  @ResponseMessage('결제 수단이 해제되었습니다.')
  @ApiResponse({ status: 200, type: BillingKeyResponseDto })
  async revoke(
    @CurrentServiceId() serviceId: string,
    @Param('billingKeyId', ParseUUIDPipe) billingKeyId: string,
  ): Promise<BillingKeyResponseDto> {
    return BillingKeyResponseDto.from(await this.billingKeyService.revoke(serviceId, billingKeyId));
  }
}
