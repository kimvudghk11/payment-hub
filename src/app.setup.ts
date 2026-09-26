import { INestApplication, ValidationPipe } from '@nestjs/common';
import { validationExceptionFactory } from './common/errors/validation-exception.factory';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

/** main.ts와 테스트가 공유하는 앱 전역 설정 */
export function setupApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
}
