import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminApi } from '../../common/decorators/auth.decorator';
import { CurrentAdminActor } from '../../common/decorators/current-actor.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AdminActor } from '../../common/types/request-context';
import { AdminProductTypeService } from './admin-product-type.service';
import {
  CreateProductTypeRequestDto,
  ListProductTypesQueryDto,
  UpdateProductTypeRequestDto,
} from './dto/request/product-type.request.dto';
import { ProductTypeResponseDto } from './dto/response/product-type.response.dto';

@ApiTags('관리자 API — 상품 유형')
@ApiBearerAuth('admin-api-key')
@ApiHeader({ name: 'X-Admin-Actor-Id', required: true, description: '작업한 관리자 ID' })
@AdminApi()
@Controller('admin/services/:serviceId/product-types')
export class AdminProductTypeController {
  constructor(private readonly productTypeService: AdminProductTypeService) {}

  @Post()
  @ApiOperation({
    summary: '상품 유형 등록',
    description: '주문 항목의 productType 화이트리스트. hub는 개별 상품(이름·가격)을 모른다',
  })
  @ResponseMessage('상품 유형이 등록되었습니다.')
  @ApiResponse({ status: 201, type: ProductTypeResponseDto })
  async create(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() dto: CreateProductTypeRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<ProductTypeResponseDto> {
    return ProductTypeResponseDto.from(await this.productTypeService.create(serviceId, dto, actor));
  }

  @Get()
  @ApiOperation({ summary: '상품 유형 목록', description: '코드순. isActive로 필터' })
  @ResponseMessage('상품 유형 목록을 조회했습니다.')
  @ApiResponse({ status: 200, type: [ProductTypeResponseDto] })
  async list(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Query() query: ListProductTypesQueryDto,
  ): Promise<ProductTypeResponseDto[]> {
    return (await this.productTypeService.list(serviceId, query.isActive)).map((p) => ProductTypeResponseDto.from(p));
  }

  @Patch(':code')
  @ApiOperation({
    summary: '상품 유형 수정·중지·재개',
    description: '삭제 대신 isActive=false로 중지 (기존 주문 항목이 참조). 바뀐 값이 없으면 감사 로그 없음',
  })
  @ResponseMessage('상품 유형이 수정되었습니다.')
  @ApiResponse({ status: 200, type: ProductTypeResponseDto })
  async update(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Param('code') code: string,
    @Body() dto: UpdateProductTypeRequestDto,
    @CurrentAdminActor() actor: AdminActor,
  ): Promise<ProductTypeResponseDto> {
    return ProductTypeResponseDto.from(await this.productTypeService.update(serviceId, code, dto.toUpdate(), actor));
  }
}
