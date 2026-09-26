import { ApiProperty } from '@nestjs/swagger';
import { PgProvider } from '../../../pg/constants/pg.constants';
import { PgEnvironment } from '../../constants/service.constants';
import { PgCredential } from '../../domain/pg-credential.entity';

/** 서비스 프론트가 결제창을 띄울 때 필요한 공개 값만. 시크릿 키는 hub만 가진다 */
export class PgClientConfigResponseDto {
  @ApiProperty({ description: 'PG사', enum: Object.values(PgProvider), example: PgProvider.TOSS })
  provider: PgProvider;

  @ApiProperty({
    description: '이 hub 배포의 PG 환경',
    enum: Object.values(PgEnvironment),
    example: PgEnvironment.LIVE,
  })
  environment: PgEnvironment;

  @ApiProperty({ description: '토스 클라이언트 키 (공개 값)', example: 'live_ck_...' })
  clientKey: string;

  static from(credential: PgCredential & { clientKey: string }): PgClientConfigResponseDto {
    const dto = new PgClientConfigResponseDto();
    dto.provider = credential.provider;
    dto.environment = credential.environment;
    dto.clientKey = credential.clientKey;
    return dto;
  }
}
