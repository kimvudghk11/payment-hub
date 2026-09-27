import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { EncryptionService } from '../common/crypto/encryption.service';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-code';
import { hubErrorForTossRejection } from '../pg/toss-error';
import { TossPaymentsClient } from '../pg/toss-payments.client';
import { ServiceService } from '../service/service.service';
import { BillingKeyPgDeleter } from './billing-key-pg-deleter';
import { BillingKeyStatus } from './constants/billing-key.constants';
import { BillingKey } from './domain/billing-key.entity';

/** 자동결제 수단(빌링키). 모든 조회·쓰기는 인증된 serviceId로 범위를 고정한다 */
@Injectable()
export class BillingKeyService {
  constructor(
    @InjectRepository(BillingKey) private readonly billingKeys: Repository<BillingKey>,
    private readonly serviceService: ServiceService,
    private readonly encryption: EncryptionService,
    private readonly toss: TossPaymentsClient,
    private readonly pgDeleter: BillingKeyPgDeleter,
  ) {}

  /**
   * 카드 등록창 인증 후 토스로 빌링키를 발급받아 암호화 저장한다.
   * 결과를 모르면(타임아웃) 저장하지 않고 PG_TIMEOUT — authKey는 한 번만 쓸 수 있으므로 사용자가 카드 등록을 다시 한다.
   */
  async issue(params: {
    serviceId: string;
    externalUserId: string;
    customerKey: string;
    authKey: string;
  }): Promise<BillingKey> {
    const credential = await this.serviceService.getActivePgCredential(params.serviceId);
    const result = await this.toss.issueBillingKey({
      secretKey: this.encryption.decrypt(credential.secretKeyEnc, credential.secretKeyId),
      authKey: params.authKey,
      customerKey: params.customerKey,
    });

    if (result.outcome === 'REJECTED') {
      throw new BusinessException(hubErrorForTossRejection(result.code, ErrorCode.BILLING_KEY_REJECTED), {
        pgCode: result.code,
        pgMessage: result.message,
      });
    }
    if (result.outcome === 'UNKNOWN') {
      const timedOut = result.reason === 'TIMEOUT' || result.reason === 'NETWORK_ERROR';
      throw new BusinessException(timedOut ? ErrorCode.PG_TIMEOUT : ErrorCode.PG_ERROR);
    }

    const issued = result.billingKey;
    const key = BillingKey.issue({
      serviceId: params.serviceId,
      externalUserId: params.externalUserId,
      customerKey: params.customerKey,
      billingKey: issued.billingKey,
      cardCompany: issued.cardCompany ?? null,
      cardNumberMasked: issued.cardNumber ?? issued.card?.number ?? null,
      encrypt: (plaintext) => this.encryption.encrypt(plaintext),
    });
    return this.billingKeys.save(key);
  }

  /** 사용자의 활성 수단 (최근 등록 순) */
  listActive(serviceId: string, externalUserId: string): Promise<BillingKey[]> {
    return this.billingKeys.find({
      where: { serviceId, externalUserId, status: BillingKeyStatus.ACTIVE },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * 해제: (tx) hub에서 REVOKED로 커밋해 다시는 결제에 쓰지 않는다 (멱등) → 토스 쪽 빌링키 삭제 1회 시도.
   * 토스 삭제가 실패해도 응답은 해제 성공이다 — 결제에 못 쓰게 하는 것은 이미 끝났고, 남은 삭제는 재시도 배치가 맡는다.
   */
  async revoke(serviceId: string, billingKeyId: string): Promise<BillingKey> {
    const key = await this.revokeInHub(serviceId, billingKeyId);
    if (key.needsPgDeletion) await this.pgDeleter.deleteOne(key.billingKeyId);
    return key;
  }

  @Transactional()
  private async revokeInHub(serviceId: string, billingKeyId: string): Promise<BillingKey> {
    const key = await this.billingKeys.findOne({
      where: { billingKeyId, serviceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!key) throw new BusinessException(ErrorCode.BILLING_KEY_NOT_FOUND);
    if (key.revoke(new Date())) await this.billingKeys.save(key);
    return key;
  }
}
