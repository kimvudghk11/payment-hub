import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { API_PREFIX } from './app.setup';

/** 실행 중인 앱의 /docs와 docs/openapi.json이 같은 설정을 쓰도록 한 곳에 둔다 */
export const buildOpenApiDocument = (app: INestApplication): OpenAPIObject =>
  SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('payment-hub')
      .setDescription(
        [
          '여러 서비스의 결제를 하나로 모으는 결제 허브 API.',
          '',
          '- 서비스 API(`/api/v1/*`): `Authorization: Bearer <서비스 API 키>` (service-api-key)',
          '- 관리자 API(`/api/v1/admin/*`): `Authorization: Bearer <admin 키>` + `X-Admin-Actor-Id` (admin-api-key)',
          '- 성공 응답은 `{ success: true, message, data }`로 감싸지고, 아래 스키마는 `data` 부분이다.',
          '- 실패 응답은 `{ success: false, code, message, detail? }`. 에러 코드는 docs/api.md 참고.',
        ].join('\n'),
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', description: '서비스 API 키 (ph_test_… / ph_live_…)' },
        'service-api-key',
      )
      .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'admin 레포 서버 전용 키' }, 'admin-api-key')
      .build(),
  );

/**
 * DB 없이 스펙을 만든다. preview 모드는 모듈 그래프만 구성하고 provider(DB 연결 등)를 만들지 않는다.
 * docs/openapi.json 생성(`npm run openapi:export`)과 최신 여부 테스트가 사용한다.
 */
export const generateOpenApiSpec = async (): Promise<string> => {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  try {
    app.setGlobalPrefix(API_PREFIX);
    return `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`;
  } finally {
    await app.close();
  }
};
