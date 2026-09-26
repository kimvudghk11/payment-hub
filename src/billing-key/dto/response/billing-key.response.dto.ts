import { ApiProperty } from '@nestjs/swagger';
import { BillingKeyStatus } from '../../constants/billing-key.constants';
import { BillingKey } from '../../domain/billing-key.entity';

/** 빌링키 원문·customerKey는 넣지 않는다. 서비스는 billingKeyId로만 자동결제를 요청한다 */
export class BillingKeyResponseDto {
  @ApiProperty({ description: '결제 수단 ID (자동결제 요청에 사용)' })
  billingKeyId: string;

  @ApiProperty({ description: '서비스 쪽 사용자 ID', example: 'user-123' })
  externalUserId: string;

  @ApiProperty({ description: '카드사', nullable: true, type: String, example: '현대' })
  cardCompany: string | null;

  @ApiProperty({ description: '마스킹된 카드번호', nullable: true, type: String, example: '433012******1234' })
  cardNumberMasked: string | null;

  @ApiProperty({ description: '상태', enum: Object.values(BillingKeyStatus), example: 'ACTIVE' })
  status: BillingKeyStatus;

  @ApiProperty({ description: '해제 시각', nullable: true, type: Date })
  revokedAt: Date | null;

  @ApiProperty({ description: '등록 시각' })
  createdAt: Date;

  static from(key: BillingKey): BillingKeyResponseDto {
    return Object.assign(new BillingKeyResponseDto(), {
      billingKeyId: key.billingKeyId,
      externalUserId: key.externalUserId,
      cardCompany: key.cardCompany,
      cardNumberMasked: key.cardNumberMasked,
      status: key.status,
      revokedAt: key.revokedAt,
      createdAt: key.createdAt,
    });
  }
}

export class BillingKeyListResponseDto {
  @ApiProperty({ type: [BillingKeyResponseDto] })
  data: BillingKeyResponseDto[];

  @ApiProperty({ description: '개수' })
  totalCount: number;

  @ApiProperty({ description: '항상 null (사용자별 수단은 한 번에 준다)', nullable: true, type: String })
  nextCursor: string | null;
}
