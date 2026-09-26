import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminGuard } from './admin.guard';
import { AuthGuard } from './auth.guard';

/** 전역 인증 가드 등록. ConfigModule(global)이 먼저 로드되어 있어야 한다. */
@Module({
  providers: [AdminGuard, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
