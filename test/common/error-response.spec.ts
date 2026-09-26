import { Body, Controller, Get, INestApplication, Post, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsInt, IsPositive, IsString, ValidateNested } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';
import { setupApp } from '../../src/app.setup';
import { BusinessException } from '../../src/common/errors/business.exception';
import { ErrorCode } from '../../src/common/errors/error-code';

interface ErrorBody {
  success: false;
  code: string;
  message: string;
  detail?: { errors?: { field: string; message: string }[] } & Record<string, unknown>;
}

const bodyOf = (res: request.Response) => res.body as ErrorBody;

class ItemDto {
  @IsInt({ message: 'quantity는 정수여야 합니다.' })
  quantity: number;
}

class CreateDto {
  @IsPositive({ message: 'amount는 0보다 커야 합니다.' })
  amount: number;

  @IsString({ message: 'name은 문자열이어야 합니다.' })
  name: string;

  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items: ItemDto[];
}

@Controller('test')
class TestController {
  @Get('business')
  business() {
    throw new BusinessException(ErrorCode.CANCEL_AMOUNT_EXCEEDED, { refundableAmount: 4000 });
  }

  @Get('business-no-detail')
  businessNoDetail() {
    throw new BusinessException(ErrorCode.ORDER_NOT_FOUND);
  }

  @Get('unexpected')
  unexpected() {
    throw new Error('relation "tb_secret" does not exist');
  }

  @Get('nest-unauthorized')
  nestUnauthorized() {
    throw new UnauthorizedException();
  }

  @Post('validate')
  validate(@Body() body: CreateDto) {
    return body;
  }
}

describe('에러 응답 형식 (전역 필터 + 검증 파이프)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [TestController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('BusinessException은 정의된 status·code·message와 detail로 응답한다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test/business');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      code: 'CANCEL_AMOUNT_EXCEEDED',
      message: '환불 가능 금액을 초과했습니다.',
      detail: { refundableAmount: 4000 },
    });
  });

  it('detail이 없으면 응답에서 detail을 생략한다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test/business-no-detail');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, code: 'ORDER_NOT_FOUND', message: '주문을 찾을 수 없습니다.' });
  });

  it('검증 실패는 400 INVALID_REQUEST, 필드별 메시지를 detail.errors 배열로 준다', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/test/validate')
      .send({ amount: -1, name: 'ok', items: [{ quantity: 1.5 }] });

    expect(res.status).toBe(400);
    expect(bodyOf(res).code).toBe('INVALID_REQUEST');
    expect(bodyOf(res).message).toBe('요청 값이 올바르지 않습니다.');
    expect(bodyOf(res).detail?.errors).toEqual(
      expect.arrayContaining([
        { field: 'amount', message: 'amount는 0보다 커야 합니다.' },
        { field: 'items.0.quantity', message: 'quantity는 정수여야 합니다.' },
      ]),
    );
    expect(bodyOf(res).detail?.errors).toHaveLength(2);
  });

  it('정의되지 않은 필드는 한국어 메시지로 거부한다', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/test/validate')
      .send({ amount: 1, name: 'ok', items: [], hacker: true });

    expect(res.status).toBe(400);
    expect(bodyOf(res).code).toBe('INVALID_REQUEST');
    expect(bodyOf(res).detail?.errors).toEqual([{ field: 'hacker', message: '허용되지 않은 필드입니다.' }]);
  });

  it('JSON 파싱 실패도 400 INVALID_REQUEST로 응답한다', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/test/validate')
      .set('Content-Type', 'application/json')
      .send('{"amount": ');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, code: 'INVALID_REQUEST', message: '요청 값이 올바르지 않습니다.' });
  });

  it('없는 경로는 404 RESOURCE_NOT_FOUND로 응답한다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      code: 'RESOURCE_NOT_FOUND',
      message: '요청한 리소스를 찾을 수 없습니다.',
    });
  });

  it('Nest 내장 401 예외는 UNAUTHORIZED로 바꾼다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test/nest-unauthorized');

    expect(res.status).toBe(401);
    expect(bodyOf(res).code).toBe('UNAUTHORIZED');
    expect(bodyOf(res).message).toBe('인증 정보가 없거나 올바르지 않습니다.');
  });

  it('예상 못 한 예외는 500 INTERNAL_ERROR, 내부 정보를 응답에 넣지 않는다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test/unexpected');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      code: 'INTERNAL_ERROR',
      message: '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
    });
    expect(JSON.stringify(res.body)).not.toContain('tb_secret');
  });
});
