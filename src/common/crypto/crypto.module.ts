import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from './encryption.service';

/** 설정이 잘못되면 EncryptionService 생성자가 실패해 부팅을 막는다 */
@Global()
@Module({
  providers: [
    {
      provide: EncryptionService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new EncryptionService(
          config.get<string>('ENCRYPTION_KEYS') ?? '',
          config.get<string>('ENCRYPTION_KEY_ID') ?? '',
        ),
    },
  ],
  exports: [EncryptionService],
})
export class CryptoModule {}
