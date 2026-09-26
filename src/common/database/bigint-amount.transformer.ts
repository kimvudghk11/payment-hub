import { ValueTransformer } from 'typeorm';

/**
 * 금액 bigint 컬럼용 transformer.
 * pg 드라이버는 bigint를 문자열로 반환하므로 number로 바꾸되,
 * 안전 정수 범위를 벗어나면 조용히 정밀도를 잃지 않고 예외를 던진다.
 */
export const bigintAmountTransformer = {
  to(value: number | null | undefined): number | null | undefined {
    if (value === null || value === undefined) return value;
    if (!Number.isSafeInteger(value)) {
      throw new Error(`금액은 안전 정수 범위의 정수여야 합니다: ${value}`);
    }
    return value;
  },

  from(value: string | null): number | null {
    if (value === null) return null;
    const amount = Number(value);
    if (!Number.isSafeInteger(amount)) {
      throw new Error(`bigint 금액이 Number.MAX_SAFE_INTEGER 범위를 벗어났습니다: ${value}`);
    }
    return amount;
  },
} satisfies ValueTransformer;
