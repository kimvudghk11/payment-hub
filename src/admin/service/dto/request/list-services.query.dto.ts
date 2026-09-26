import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ValidationMessage } from '../../../../common/utils/validation-message.util';
import { ServiceStatus } from '../../../../service/constants/service.constants';

export class ListServicesQueryDto {
  @ApiPropertyOptional({ description: '상태 필터', enum: Object.values(ServiceStatus) })
  @IsOptional()
  @IsIn(Object.values(ServiceStatus), { message: ValidationMessage.oneOf('status', Object.values(ServiceStatus)) })
  status?: ServiceStatus;

  @ApiPropertyOptional({ description: '삭제된 서비스 포함 여부', default: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean({ message: ValidationMessage.boolean('includeDeleted') })
  includeDeleted?: boolean;

  @ApiPropertyOptional({ description: '페이지 크기', default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: ValidationMessage.integer('limit') })
  @Min(1, { message: ValidationMessage.min('limit', 1) })
  @Max(100, { message: ValidationMessage.max('limit', 100) })
  limit?: number;

  @ApiPropertyOptional({ description: '이전 응답의 nextCursor' })
  @IsOptional()
  @IsString({ message: ValidationMessage.string('cursor') })
  cursor?: string;
}
