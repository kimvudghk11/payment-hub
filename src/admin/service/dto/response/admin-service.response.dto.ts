import { ApiProperty } from '@nestjs/swagger';
import { ServiceStatus } from '../../../../service/constants/service.constants';
import { Service } from '../../../../service/domain/service.entity';

/** 관리자용 서비스 정보. 웹훅 서명 키는 존재 여부만 노출 */
export class AdminServiceResponseDto {
  @ApiProperty({ description: '서비스 ID', example: '0b6f3c1e-2d4a-4b8e-9f10-123456789abc' })
  serviceId: string;

  @ApiProperty({ description: '서비스 코드', example: 'SVC_A' })
  code: string;

  @ApiProperty({ description: '서비스 이름', example: '서비스 A' })
  name: string;

  @ApiProperty({ description: '상태', enum: Object.values(ServiceStatus), example: ServiceStatus.ACTIVE })
  status: ServiceStatus;

  @ApiProperty({
    description: '웹훅 URL',
    example: 'https://svc-a.example.com/webhooks/payment-hub',
    nullable: true,
    type: String,
  })
  webhookUrl: string | null;

  @ApiProperty({ description: '웹훅 서명 키 발급 여부 (키 자체는 발급·교체 응답에서 1회만)', example: true })
  hasWebhookSecret: boolean;

  @ApiProperty({ description: '삭제 시각 (soft delete)', nullable: true, type: Date, example: null })
  deletedAt: Date | null;

  @ApiProperty({ description: '생성 시각', example: '2026-09-26T07:15:22.323Z' })
  createdAt: Date;

  @ApiProperty({ description: '수정 시각', example: '2026-09-26T07:15:22.323Z' })
  updatedAt: Date;

  static from(service: Service): AdminServiceResponseDto {
    const dto = new AdminServiceResponseDto();
    dto.serviceId = service.serviceId;
    dto.code = service.code;
    dto.name = service.name;
    dto.status = service.status;
    dto.webhookUrl = service.webhookUrl;
    dto.hasWebhookSecret = service.webhookSecretEnc !== null;
    dto.deletedAt = service.deletedAt;
    dto.createdAt = service.createdAt;
    dto.updatedAt = service.updatedAt;
    return dto;
  }
}

/** 등록 응답. webhookSecret 평문은 이 응답에서 1회만 */
export class CreatedServiceResponseDto extends AdminServiceResponseDto {
  @ApiProperty({ description: '웹훅 HMAC 서명 키 평문. 이 응답에서만 제공', example: 'whsec_9f2c...' })
  webhookSecret: string;

  static withSecret(service: Service, webhookSecret: string): CreatedServiceResponseDto {
    return Object.assign(new CreatedServiceResponseDto(), AdminServiceResponseDto.from(service), { webhookSecret });
  }
}

export class WebhookSecretResponseDto {
  @ApiProperty({ description: '서비스 ID', example: '0b6f3c1e-2d4a-4b8e-9f10-123456789abc' })
  serviceId: string;

  @ApiProperty({ description: '새 웹훅 서명 키 평문. 이 응답에서만 제공', example: 'whsec_9f2c...' })
  webhookSecret: string;
}

export class AdminServicePageResponseDto {
  @ApiProperty({ type: [AdminServiceResponseDto] })
  data: AdminServiceResponseDto[];

  @ApiProperty({ description: '필터에 맞는 전체 개수', example: 12 })
  totalCount: number;

  @ApiProperty({ description: '다음 페이지 cursor. 마지막 페이지면 null', nullable: true, type: String })
  nextCursor: string | null;
}
