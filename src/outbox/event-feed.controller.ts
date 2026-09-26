import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ServiceApi } from '../common/decorators/auth.decorator';
import { CurrentServiceId } from '../common/decorators/current-actor.decorator';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { IPageable } from '../common/interceptors/response.interceptor';
import { ValidationMessage } from '../common/utils/validation-message.util';
import { OutboxEvent } from './domain/outbox-event.entity';
import { EventFeedService } from './event-feed.service';

class ListEventsQueryDto {
  @ApiPropertyOptional({ description: '마지막으로 처리한 eventId. 없으면 처음부터' })
  @IsOptional()
  @IsUUID('all', { message: ValidationMessage.uuid('after') })
  after?: string;

  @ApiPropertyOptional({ description: '최대 개수', default: 100, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: ValidationMessage.integer('limit') })
  @Min(1, { message: ValidationMessage.min('limit', 1) })
  @Max(500, { message: ValidationMessage.max('limit', 500) })
  limit?: number;
}

/** 웹훅 본문과 같은 형태 */
export class EventResponseDto {
  @ApiProperty({ description: '이벤트 ID (웹훅 X-PaymentHub-Event-Id와 같음)' })
  eventId: string;

  @ApiProperty({ description: '이벤트 유형', example: 'PAYMENT_CONFIRMED' })
  eventType: string;

  @ApiProperty({ description: '발행 시각' })
  occurredAt: Date;

  @ApiProperty({ description: '웹훅 data와 같은 내용', type: Object })
  data: Record<string, unknown>;

  static from(event: OutboxEvent): EventResponseDto {
    return Object.assign(new EventResponseDto(), {
      eventId: event.outboxEventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      data: event.payload,
    });
  }
}

class EventPageResponseDto {
  @ApiProperty({ type: [EventResponseDto] })
  data: EventResponseDto[];

  @ApiProperty({ description: 'after 이후 남은 이벤트 수' })
  totalCount: number;

  @ApiProperty({ description: '다음 조회의 after 값. 더 없으면 null', nullable: true, type: String })
  nextCursor: string | null;
}

@ApiTags('서비스 API — 이벤트')
@ApiBearerAuth('service-api-key')
@ServiceApi()
@Controller('events')
export class EventFeedController {
  constructor(private readonly feed: EventFeedService) {}

  @Get()
  @ApiOperation({
    summary: '이벤트 재조회',
    description:
      '웹훅을 놓쳤을 때 발행 순서대로 따라잡는다. 마지막으로 처리한 eventId를 after로 준다. 발행 직후(기본 5초) 이벤트는 다음 조회에서 나온다. eventId로 중복 처리를 거른다',
  })
  @ResponseMessage('이벤트를 조회했습니다.')
  @ApiResponse({ status: 200, type: EventPageResponseDto })
  async list(
    @CurrentServiceId() serviceId: string,
    @Query() query: ListEventsQueryDto,
  ): Promise<IPageable<EventResponseDto>> {
    const page = await this.feed.list(serviceId, query);
    return { ...page, data: page.data.map((event) => EventResponseDto.from(event)) };
  }
}
