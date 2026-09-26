import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TossPaymentsClient } from './toss-payments.client';

const DEFAULT_TOSS_API_BASE_URL = 'https://api.tosspayments.com';
/** 토스는 승인 API 읽기 타임아웃을 넉넉히(최대 60초) 두라고 권장한다. 넘기면 UNKNOWN → 대사 */
const DEFAULT_TOSS_API_TIMEOUT_MS = 30_000;

@Module({
  providers: [
    {
      provide: TossPaymentsClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const timeoutMs = Number(config.get<string>('TOSS_API_TIMEOUT_MS') ?? DEFAULT_TOSS_API_TIMEOUT_MS);
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
          throw new Error(`TOSS_API_TIMEOUT_MS는 양의 정수(ms)여야 합니다: ${timeoutMs}`);
        }
        return new TossPaymentsClient({
          baseUrl: config.get<string>('TOSS_API_BASE_URL') ?? DEFAULT_TOSS_API_BASE_URL,
          timeoutMs,
        });
      },
    },
  ],
  exports: [TossPaymentsClient],
})
export class PgModule {}
