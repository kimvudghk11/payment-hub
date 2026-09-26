import { BusinessException } from '../../src/common/errors/business.exception';
import { ErrorCode } from '../../src/common/errors/error-code';

describe('ErrorCode', () => {
  it('각 에러의 code는 키 이름과 같다 (서비스가 분기에 쓰는 안정적인 식별자)', () => {
    for (const [key, error] of Object.entries(ErrorCode)) {
      expect(error.code).toBe(key);
    }
  });

  it('모든 에러는 4xx/5xx status와 한국어 메시지를 가진다', () => {
    for (const error of Object.values(ErrorCode)) {
      expect(error.status).toBeGreaterThanOrEqual(400);
      expect(error.status).toBeLessThan(600);
      expect(error.message).toMatch(/[가-힣]/);
    }
  });

  it('CLAUDE.md 기본 에러 코드 표의 값을 그대로 가진다', () => {
    expect(ErrorCode.ORDER_NOT_FOUND).toEqual({
      code: 'ORDER_NOT_FOUND',
      status: 404,
      message: '주문을 찾을 수 없습니다.',
    });
    expect(ErrorCode.CANCEL_AMOUNT_EXCEEDED.status).toBe(400);
    expect(ErrorCode.PG_TIMEOUT.status).toBe(504);
    expect(ErrorCode.INTERNAL_ERROR.message).toBe('일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
    expect(Object.keys(ErrorCode)).toHaveLength(25);
  });
});

describe('BusinessException', () => {
  it('에러 코드와 detail을 그대로 담는다', () => {
    const exception = new BusinessException(ErrorCode.CANCEL_AMOUNT_EXCEEDED, { refundableAmount: 4000 });

    expect(exception.errorCode).toBe(ErrorCode.CANCEL_AMOUNT_EXCEEDED);
    expect(exception.detail).toEqual({ refundableAmount: 4000 });
    expect(exception.message).toBe('환불 가능 금액을 초과했습니다.');
  });

  it('detail은 생략할 수 있다', () => {
    expect(new BusinessException(ErrorCode.ORDER_NOT_FOUND).detail).toBeUndefined();
  });
});
