import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-code';
import { IPageable } from '../common/interceptors/response.interceptor';
import { OutboxEvent } from './domain/outbox-event.entity';

export const EVENT_FEED_DEFAULT_LIMIT = 100;
const DEFAULT_LAG_MS = 5_000;

/**
 * 이벤트 재조회 — 웹훅을 놓친 서비스가 발행 순서(occurred_at, id)대로 따라잡는다.
 * 발행 직후 lag 안의 이벤트는 주지 않는다: 먼저 발행됐지만 늦게 커밋되는 이벤트가 있으면
 * 커서가 그 앞을 지나가 버려 영영 건너뛰게 되기 때문. 서비스는 eventId로 중복을 거른다.
 */
@Injectable()
export class EventFeedService {
  readonly lagMs: number;

  constructor(
    @InjectRepository(OutboxEvent) private readonly events: Repository<OutboxEvent>,
    config: ConfigService,
  ) {
    this.lagMs = Number(config.get<string>('EVENT_FEED_LAG_MS') ?? DEFAULT_LAG_MS);
    if (!Number.isInteger(this.lagMs) || this.lagMs < 0) {
      throw new Error(`EVENT_FEED_LAG_MS는 0 이상의 정수(ms)여야 합니다: ${this.lagMs}`);
    }
  }

  async list(
    serviceId: string,
    query: { after?: string; limit?: number },
    now: Date = new Date(),
    lagMs: number = this.lagMs,
  ): Promise<IPageable<OutboxEvent>> {
    if (query.after && !(await this.events.existsBy({ outboxEventId: query.after, serviceId }))) {
      throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
    }
    const limit = query.limit ?? EVENT_FEED_DEFAULT_LIMIT;

    const filtered = this.events
      .createQueryBuilder('e')
      .where('e.serviceId = :serviceId', { serviceId })
      .andWhere('e.occurredAt <= :visibleUntil', { visibleUntil: new Date(now.getTime() - lagMs) });
    if (query.after) {
      // 시각 정밀도 손실 없이 DB 값끼리 비교
      filtered.andWhere(
        '(e.occurred_at, e.id) > (SELECT a.occurred_at, a.id FROM tb_outbox_event a WHERE a.id = :after)',
        { after: query.after },
      );
    }

    const totalCount = await filtered.clone().getCount();
    const rows = await filtered
      .orderBy('e.occurredAt', 'ASC')
      .addOrderBy('e.outboxEventId', 'ASC')
      .take(limit + 1)
      .getMany();
    const data = rows.slice(0, limit);
    return {
      data,
      totalCount,
      nextCursor: rows.length > limit ? data[data.length - 1].outboxEventId : null,
    };
  }
}
