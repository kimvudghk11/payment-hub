import { ApiProperty } from '@nestjs/swagger';
import { ServiceApiKey } from '../../../../service/domain/service-api-key.entity';

/** API 키 정보. 해시·평문은 포함하지 않는다 */
export class ApiKeyResponseDto {
  @ApiProperty({ description: 'API 키 ID', example: '7c1e0a2b-...' })
  apiKeyId: string;

  @ApiProperty({ description: '서비스 ID', example: '0b6f3c1e-...' })
  serviceId: string;

  @ApiProperty({ description: '키 용도', example: 'prod-server-1' })
  label: string;

  @ApiProperty({ description: '환경 prefix', example: 'ph_live_' })
  keyPrefix: string;

  @ApiProperty({ description: '키 끝 4자리', example: 'a1B9' })
  keyHint: string;

  @ApiProperty({ description: '만료 시각. null이면 만료 없음', nullable: true, type: Date })
  expiresAt: Date | null;

  @ApiProperty({
    description: '마지막 사용 시각. 키 교체 시 구 키가 더 이상 쓰이지 않는지 확인',
    nullable: true,
    type: Date,
  })
  lastUsedAt: Date | null;

  @ApiProperty({ description: '폐기 시각. null이면 유효', nullable: true, type: Date })
  revokedAt: Date | null;

  @ApiProperty({ description: '발급 시각', example: '2026-09-26T07:15:22.323Z' })
  createdAt: Date;

  static from(apiKey: ServiceApiKey): ApiKeyResponseDto {
    const dto = new ApiKeyResponseDto();
    dto.apiKeyId = apiKey.serviceApiKeyId;
    dto.serviceId = apiKey.serviceId;
    dto.label = apiKey.label;
    dto.keyPrefix = apiKey.keyPrefix;
    dto.keyHint = apiKey.keyHint;
    dto.expiresAt = apiKey.expiresAt;
    dto.lastUsedAt = apiKey.lastUsedAt;
    dto.revokedAt = apiKey.revokedAt;
    dto.createdAt = apiKey.createdAt;
    return dto;
  }
}

/** 발급 응답. apiKey 평문은 이 응답에서 1회만 */
export class IssuedApiKeyResponseDto extends ApiKeyResponseDto {
  @ApiProperty({
    description: 'API 키 평문. 이 응답에서만 제공 — 서비스는 Authorization: Bearer <apiKey>로 사용',
    example: 'ph_live_4Jt9xQ2mV8...',
  })
  apiKey: string;

  static withPlaintext(apiKey: ServiceApiKey, plaintext: string): IssuedApiKeyResponseDto {
    return Object.assign(new IssuedApiKeyResponseDto(), ApiKeyResponseDto.from(apiKey), { apiKey: plaintext });
  }
}
