import { bigintAmountTransformer } from '../../src/common/database/bigint-amount.transformer';

describe('bigintAmountTransformer', () => {
  describe('from (DB → 엔티티)', () => {
    it('pg 드라이버가 문자열로 준 bigint를 number로 변환한다', () => {
      expect(bigintAmountTransformer.from('10000')).toBe(10000);
    });

    it('0도 그대로 변환한다', () => {
      expect(bigintAmountTransformer.from('0')).toBe(0);
    });

    it('Number.MAX_SAFE_INTEGER까지는 변환한다', () => {
      expect(bigintAmountTransformer.from(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('Number.MAX_SAFE_INTEGER를 넘으면 정밀도 손실 대신 예외를 던진다', () => {
      expect(() => bigintAmountTransformer.from('9007199254740992')).toThrow(/MAX_SAFE_INTEGER/);
    });

    it('음수 최소 안전 정수 미만도 예외를 던진다', () => {
      expect(() => bigintAmountTransformer.from('-9007199254740992')).toThrow(/MAX_SAFE_INTEGER/);
    });

    it('null은 null로 둔다 (nullable 컬럼)', () => {
      expect(bigintAmountTransformer.from(null)).toBeNull();
    });
  });

  describe('to (엔티티 → DB)', () => {
    it('number를 그대로 넘긴다', () => {
      expect(bigintAmountTransformer.to(10000)).toBe(10000);
    });

    it('정수가 아닌 금액은 저장하지 않는다 (minor unit 원칙)', () => {
      expect(() => bigintAmountTransformer.to(100.5)).toThrow(/정수/);
    });

    it('안전 정수 범위를 넘는 금액은 저장하지 않는다', () => {
      expect(() => bigintAmountTransformer.to(Number.MAX_SAFE_INTEGER + 1)).toThrow(/정수/);
    });

    it('null/undefined는 그대로 넘긴다 (DB 기본값·nullable)', () => {
      expect(bigintAmountTransformer.to(null)).toBeNull();
      expect(bigintAmountTransformer.to(undefined)).toBeUndefined();
    });
  });
});
