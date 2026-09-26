import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHash } from 'crypto';
import { Request } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { setupApp } from '../../src/app.setup';
import { AdminApi, Public, ServiceApi } from '../../src/common/decorators/auth.decorator';
import { BusinessException } from '../../src/common/errors/business.exception';
import { ErrorCode } from '../../src/common/errors/error-code';
import { AuthModule } from '../../src/common/guards/auth.module';
import { ApiKeyGuard } from '../../src/service/api-key.guard';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ADMIN_KEY = 'admin-key-current';
const ADMIN_KEY_NEXT = 'admin-key-next';

interface ErrorBody {
  code: string;
}
const codeOf = (res: request.Response) => (res.body as ErrorBody).code;

@Controller('guard-test')
class GuardTestController {
  @Public()
  @Get('public')
  publicRoute() {
    return { ok: true };
  }

  @Get('undecorated')
  undecorated() {
    return { ok: true };
  }

  @ServiceApi()
  @Get('service')
  serviceRoute() {
    return { ok: true };
  }

  @AdminApi()
  @Get('admin')
  adminRoute(@Req() req: Request) {
    return req.adminActor;
  }
}

@AdminApi()
@Controller('admin/class-level')
class ClassLevelAdminController {
  @Get()
  inherited() {
    return { ok: true };
  }

  @Public()
  @Get('public')
  overridden() {
    return { ok: true };
  }
}

/** ApiKeyGuard 대역: 기본은 거부, 테스트가 한 번씩 통과시킬 수 있다 */
const apiKeyGuardVerdict = jest.fn<boolean, []>(() => {
  throw new BusinessException(ErrorCode.UNAUTHORIZED);
});

const createApp = async (adminKeyHashes: string): Promise<INestApplication<App>> => {
  process.env.ADMIN_API_KEY_HASHES = adminKeyHashes;
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), AuthModule],
    controllers: [GuardTestController, ClassLevelAdminController],
  })
    .overrideProvider(ApiKeyGuard)
    .useValue({ canActivate: () => apiKeyGuardVerdict() })
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
  setupApp(app);
  await app.init();
  return app;
};

describe('인증 가드 (기본 거부)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  const adminHeaders = { Authorization: `Bearer ${ADMIN_KEY}`, 'X-Admin-Actor-Id': 'admin-7' };

  beforeAll(async () => {
    app = await createApp(`${sha256(ADMIN_KEY)},${sha256(ADMIN_KEY_NEXT)}`);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('기본 거부', () => {
    it('@Public 핸들러는 인증 없이 통과한다', async () => {
      const res = await http().get('/api/v1/guard-test/public');

      expect(res.status).toBe(200);
    });

    it('인증 데코레이터가 없는 핸들러는 거부한다', async () => {
      const res = await http().get('/api/v1/guard-test/undecorated').set(adminHeaders);

      expect(res.status).toBe(401);
      expect(codeOf(res)).toBe('UNAUTHORIZED');
    });

    // ApiKeyGuard 자체(DB 조회·폐기·만료·정지)는 test/service/api-key-auth.int-spec.ts에서 실제 DB로 검증한다
    it('@ServiceApi 핸들러는 ApiKeyGuard의 판정을 따른다', async () => {
      apiKeyGuardVerdict.mockReturnValueOnce(true);
      const allowed = await http().get('/api/v1/guard-test/service');
      const denied = await http().get('/api/v1/guard-test/service');

      expect(allowed.status).toBe(200);
      expect(denied.status).toBe(401);
      expect(codeOf(denied)).toBe('UNAUTHORIZED');
    });

    it('@AdminApi 핸들러는 ApiKeyGuard를 거치지 않는다', async () => {
      apiKeyGuardVerdict.mockClear();

      await http().get('/api/v1/guard-test/admin').set(adminHeaders);

      expect(apiKeyGuardVerdict).not.toHaveBeenCalled();
    });

    it('컨트롤러에 붙인 @AdminApi가 핸들러에 적용된다', async () => {
      const denied = await http().get('/api/v1/admin/class-level');
      const allowed = await http().get('/api/v1/admin/class-level').set(adminHeaders);

      expect(denied.status).toBe(401);
      expect(allowed.status).toBe(200);
    });

    it('핸들러의 데코레이터가 컨트롤러 데코레이터보다 우선한다', async () => {
      const res = await http().get('/api/v1/admin/class-level/public');

      expect(res.status).toBe(200);
    });
  });

  describe('@AdminApi', () => {
    it('Authorization 헤더가 없으면 401 UNAUTHORIZED', async () => {
      const res = await http().get('/api/v1/guard-test/admin').set('X-Admin-Actor-Id', 'admin-7');

      expect(res.status).toBe(401);
      expect(codeOf(res)).toBe('UNAUTHORIZED');
    });

    it('등록되지 않은 키는 401 UNAUTHORIZED', async () => {
      const res = await http()
        .get('/api/v1/guard-test/admin')
        .set({ Authorization: 'Bearer wrong-key', 'X-Admin-Actor-Id': 'admin-7' });

      expect(res.status).toBe(401);
      expect(codeOf(res)).toBe('UNAUTHORIZED');
    });

    it('서비스 API 키로는 관리자 API를 호출할 수 없다', async () => {
      const res = await http()
        .get('/api/v1/guard-test/admin')
        .set({ Authorization: 'Bearer ph_live_4Jt9xQ2mV8', 'X-Admin-Actor-Id': 'admin-7' });

      expect(res.status).toBe(401);
      expect(codeOf(res)).toBe('UNAUTHORIZED');
    });

    it('Bearer가 아닌 인증 방식은 거부한다', async () => {
      const res = await http()
        .get('/api/v1/guard-test/admin')
        .set({ Authorization: `Basic ${ADMIN_KEY}`, 'X-Admin-Actor-Id': 'admin-7' });

      expect(res.status).toBe(401);
      expect(codeOf(res)).toBe('UNAUTHORIZED');
    });

    it('키가 맞아도 X-Admin-Actor-Id가 없으면 400 ADMIN_ACTOR_REQUIRED', async () => {
      const res = await http().get('/api/v1/guard-test/admin').set('Authorization', `Bearer ${ADMIN_KEY}`);

      expect(res.status).toBe(400);
      expect(codeOf(res)).toBe('ADMIN_ACTOR_REQUIRED');
    });

    it('X-Admin-Actor-Id가 100자를 넘으면 400 INVALID_REQUEST (감사 로그 컬럼 길이)', async () => {
      const res = await http()
        .get('/api/v1/guard-test/admin')
        .set({ Authorization: `Bearer ${ADMIN_KEY}`, 'X-Admin-Actor-Id': 'a'.repeat(101) });

      expect(res.status).toBe(400);
      expect(codeOf(res)).toBe('INVALID_REQUEST');
    });

    it.each(['X-Admin-Actor-Name', 'X-Request-Id'])('%s가 100자를 넘으면 400 INVALID_REQUEST', async (header) => {
      const res = await http()
        .get('/api/v1/guard-test/admin')
        .set({ ...adminHeaders, [header]: 'a'.repeat(101) });

      expect(res.status).toBe(400);
      expect(codeOf(res)).toBe('INVALID_REQUEST');
    });

    it('인증되면 관리자 정보를 req.adminActor에 넣는다 (이름은 URL 디코딩)', async () => {
      const res = await http()
        .get('/api/v1/guard-test/admin')
        .set({
          ...adminHeaders,
          'X-Admin-Actor-Name': encodeURIComponent('홍길동'),
          'X-Request-Id': 'req-123',
        });

      expect(res.status).toBe(200);
      expect((res.body as { data: unknown }).data).toEqual(
        expect.objectContaining({ actorId: 'admin-7', actorName: '홍길동', requestId: 'req-123' }),
      );
    });

    it('등록된 키가 여러 개면 어느 키로도 통과한다 (무중단 교체)', async () => {
      const res = await http()
        .get('/api/v1/guard-test/admin')
        .set({ Authorization: `Bearer ${ADMIN_KEY_NEXT}`, 'X-Admin-Actor-Id': 'admin-7' });

      expect(res.status).toBe(200);
    });
  });

  describe('ADMIN_API_KEY_HASHES 설정', () => {
    it('SHA-256 hex가 아닌 값이 있으면 부팅을 실패시킨다', async () => {
      await expect(createApp(`${sha256(ADMIN_KEY)},not-a-hash`)).rejects.toThrow(/ADMIN_API_KEY_HASHES/);
    });

    it('비어 있으면 부팅은 되지만 모든 관리자 요청을 거부한다', async () => {
      const emptyApp = await createApp('');
      try {
        const res = await request(emptyApp.getHttpServer()).get('/api/v1/guard-test/admin').set(adminHeaders);

        expect(res.status).toBe(401);
      } finally {
        await emptyApp.close();
      }
    });
  });
});
