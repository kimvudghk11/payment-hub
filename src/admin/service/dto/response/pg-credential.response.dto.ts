import { ApiProperty } from '@nestjs/swagger';
import { PgProvider } from '../../../../pg/constants/pg.constants';
import { PgEnvironment } from '../../../../service/constants/service.constants';
import { PgCredential } from '../../../../service/domain/pg-credential.entity';

/** PG 자격증명. 시크릿 키는 어떤 경우에도 포함하지 않고 끝 4자리 hint만 */
export class PgCredentialResponseDto {
  @ApiProperty({ description: 'PG 자격증명 ID', example: '5d2a...' })
  pgCredentialId: string;

  @ApiProperty({ description: '서비스 ID', example: '0b6f...' })
  serviceId: string;

  @ApiProperty({ description: 'PG사', enum: Object.values(PgProvider), example: PgProvider.TOSS })
  provider: PgProvider;

  @ApiProperty({ description: '환경', enum: Object.values(PgEnvironment), example: PgEnvironment.LIVE })
  environment: PgEnvironment;

  @ApiProperty({ description: '토스 상점 ID', nullable: true, type: String, example: 'tosspayments' })
  merchantId: string | null;

  @ApiProperty({ description: '클라이언트 키 (공개 값)', nullable: true, type: String, example: 'live_ck_...' })
  clientKey: string | null;

  @ApiProperty({ description: '시크릿 키 끝 4자리', example: '1a2b' })
  secretKeyHint: string;

  @ApiProperty({ description: '활성 여부. (서비스, 환경)당 활성 1개', example: true })
  isActive: boolean;

  @ApiProperty({ description: '등록 시각', example: '2026-09-27T01:00:00.000Z' })
  createdAt: Date;

  static from(credential: PgCredential): PgCredentialResponseDto {
    const dto = new PgCredentialResponseDto();
    dto.pgCredentialId = credential.pgCredentialId;
    dto.serviceId = credential.serviceId;
    dto.provider = credential.provider;
    dto.environment = credential.environment;
    dto.merchantId = credential.merchantId;
    dto.clientKey = credential.clientKey;
    dto.secretKeyHint = credential.secretKeyHint;
    dto.isActive = credential.isActive;
    dto.createdAt = credential.createdAt;
    return dto;
  }
}
