import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { setupApp } from '../../src/app.setup';
import { ResponseMessage } from '../../src/common/decorators/response-message.decorator';
import { BusinessException } from '../../src/common/errors/business.exception';
import { ErrorCode } from '../../src/common/errors/error-code';

@Controller('envelope')
class EnvelopeController {
  @ResponseMessage('서비스가 등록되었습니다.')
  @Post()
  create() {
    return { serviceId: 'svc-1' };
  }

  @Get('no-message')
  noMessage() {
    return [1, 2];
  }

  @ResponseMessage('성공 메시지는 에러에 쓰이지 않는다')
  @Get('error')
  error() {
    throw new BusinessException(ErrorCode.ORDER_NOT_FOUND);
  }
}

describe('성공 응답 형식 (IResponseBase)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [EnvelopeController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('핸들러 반환값을 { success, message, data }로 감싼다', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/envelope');

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, message: '서비스가 등록되었습니다.', data: { serviceId: 'svc-1' } });
  });

  it('@ResponseMessage가 없으면 기본 메시지를 쓴다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/envelope/no-message');

    expect(res.body).toEqual({ success: true, message: '요청을 처리했습니다.', data: [1, 2] });
  });

  it('에러 응답은 감싸지 않는다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/envelope/error');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, code: 'ORDER_NOT_FOUND', message: '주문을 찾을 수 없습니다.' });
  });
});
