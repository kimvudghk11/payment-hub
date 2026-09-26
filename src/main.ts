import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { initializeTransactionalContext } from 'typeorm-transactional';
import { AppModule } from './app.module';
import { setupApp } from './app.setup';
import { buildOpenApiDocument } from './openapi';

async function bootstrap() {
  // AppModule 생성 전에 호출해야 @Transactional()이 동작한다
  initializeTransactionalContext();

  // 서버 간 통신 전용이므로 CORS는 켜지 않는다
  const app = await NestFactory.create(AppModule, { cors: false });
  const config = app.get(ConfigService);

  setupApp(app);
  app.enableShutdownHooks();

  if (config.get<string>('NODE_ENV') !== 'production') {
    SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
  }

  const port = Number(config.get<string>('PORT', '3000'));
  await app.listen(port);
  Logger.log(`payment-hub listening on :${port}`, 'Bootstrap');
}

void bootstrap();
