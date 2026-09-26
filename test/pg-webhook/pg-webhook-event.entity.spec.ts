import { createHash } from 'crypto';
import { PgWebhookEventStatus } from '../../src/pg-webhook/constants/pg-webhook.constants';
import { PgWebhookEvent } from '../../src/pg-webhook/domain/pg-webhook-event.entity';

const now = new Date('2026-09-28T01:00:00.000Z');

describe('PgWebhookEvent', () => {
  it('receive: RECEIVED로 기록, 중복 방지 키 = 이벤트 유형·대상·상태·토스 발생 시각', () => {
    const event = PgWebhookEvent.receive(
      {
        eventType: 'PAYMENT_STATUS_CHANGED',
        reference: 'tgen_abc',
        status: 'DONE',
        createdAt: '2026-09-28T10:00:00.000',
      },
      { any: 'payload' },
      now,
    );

    expect(event).toMatchObject({
      provider: 'TOSS',
      eventType: 'PAYMENT_STATUS_CHANGED',
      dedupKey: 'PAYMENT_STATUS_CHANGED:tgen_abc:DONE:2026-09-28T10:00:00.000',
      payload: { any: 'payload' },
      status: PgWebhookEventStatus.RECEIVED,
      receivedAt: now,
      processedAt: null,
      error: null,
    });
  });

  it('키가 컬럼 한도(200)를 넘으면 해시로 줄인다', () => {
    const reference = 'x'.repeat(300);
    const event = PgWebhookEvent.receive({ eventType: 'E', reference, status: 'S', createdAt: 'T' }, {}, now);
    expect(event.dedupKey).toBe(`sha256:${createHash('sha256').update(`E:${reference}:S:T`).digest('hex')}`);
  });

  it.each([
    ['markProcessed', PgWebhookEventStatus.PROCESSED, null],
    ['markIgnored', PgWebhookEventStatus.IGNORED, '대상 결제 없음'],
    ['markFailed', PgWebhookEventStatus.FAILED, '토스 재확인 실패'],
  ] as const)('%s → %s', (method, status, reason) => {
    const event = PgWebhookEvent.receive({ eventType: 'E', reference: 'r', status: 'S', createdAt: 'T' }, {}, now);
    if (method === 'markProcessed') event.markProcessed(now);
    else event[method](reason ?? '', now);

    expect(event).toMatchObject({ status, processedAt: now, error: reason });
  });
});
