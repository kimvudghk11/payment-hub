import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { initializeTransactionalContext } from 'typeorm-transactional';
import { AppModule } from './app.module';
import { setupApp } from './app.setup';

async function bootstrap() {
  // AppModule 생성 전에 호출해야 @Transactional()이 동작한다
  initializeTransactionalContext();

  // 서버 간 통신 전용이므로 CORS는 켜지 않는다
  const app = await NestFactory.create(AppModule, { cors: false });
  const config = app.get(ConfigService);

  setupApp(app);
  app.enableShutdownHooks();

  if (config.get<string>('NODE_ENV') !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('payment-hub')
        .setDescription('여러 서비스의 결제를 하나로 모으는 결제 허브 API')
        .setVersion('1.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'service-api-key')
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'admin-api-key')
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }

  const port = Number(config.get<string>('PORT', '3000'));
  await app.listen(port);
  Logger.log(`payment-hub listening on :${port}`, 'Bootstrap');
}

void bootstrap();
