import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { EncryptionService } from '../common/crypto/encryption.service';
import { TossDeleteResult, TossPaymentsClient } from '../pg/toss-payments.client';
import { ServiceService } from '../service/service.service';
import { BILLING_KEY_PG_DELETE_MAX_ATTEMPTS, BillingKeyStatus } from './constants/billing-key.constants';
import { BillingKey } from './domain/billing-key.entity';

export const BILLING_KEY_PG_DELETE_BATCH_SIZE = 20;

export interface PgDeleteBatchResult {
  checked: number;
  deleted: number;
  /** 거절·결과 불명·처리 중 예외 (실패 시도로 기록되고 백오프 뒤 다시 시도된다) */
  failed: number;
}

/**
 * 해제(REVOKED)한 빌링키를 토스에서도 삭제한다. hub 폐기는 이미 커밋된 뒤라 결제에는 쓰이지 않고,
 * 이 작업은 토스에 남은 키를 치우는 뒷정리다.
 * 토스 호출은 트랜잭션 밖, 결과 반영은 행 락 + 상태 재확인. 여러 인스턴스가 같은 키를 동시에 삭제 요청해도
 * 토스 삭제는 멱등(404 = 삭제됨)이고 기록은 한 번만 된다.
 * 실패하면 시도 횟수를 올리고, 다음 시도는 2^시도횟수 분 뒤 (10회 한도까지 약 17시간).
 */
@Injectable()
export class BillingKeyPgDeleter {
  private readonly logger = new Logger(BillingKeyPgDeleter.name);

  constructor(
    @InjectRepository(BillingKey) private readonly billingKeys: Repository<BillingKey>,
    private readonly serviceService: ServiceService,
    private readonly encryption: EncryptionService,
    private readonly toss: TossPaymentsClient,
  ) {}

  /** 재시도 배치: 백오프가 지난 삭제 대기 키를 오래 기다린 순으로 */
  async deleteDue(
    now: Date = new Date(),
    limit: number = BILLING_KEY_PG_DELETE_BATCH_SIZE,
  ): Promise<PgDeleteBatchResult> {
    const due = await this.billingKeys
      .createQueryBuilder('k')
      .select('k.billingKeyId')
      .where({ status: BillingKeyStatus.REVOKED })
      .andWhere('k.pg_deleted_at IS NULL')
      .andWhere('k.pg_delete_attempt_count < :max', { max: BILLING_KEY_PG_DELETE_MAX_ATTEMPTS })
      .andWhere(`k.updated_at <= :now::timestamptz - interval '1 minute' * power(2, k.pg_delete_attempt_count)`, {
        now,
      })
      .orderBy('k.updatedAt', 'ASC')
      .limit(limit)
      .getMany();

    const result: PgDeleteBatchResult = { checked: due.length, deleted: 0, failed: 0 };
    for (const { billingKeyId } of due) {
      const outcome = await this.deleteOne(billingKeyId);
      if (outcome === 'DELETED') result.deleted += 1;
      if (outcome === 'FAILED') result.failed += 1;
    }
    return result;
  }

  /**
   * 한 키의 토스 삭제를 시도하고 결과를 기록한다. 예외를 던지지 않는다 — 해제 API 응답과 배치를 막지 않게,
   * 복호화할 수 없는 키·자격증명 누락도 실패 시도로 남겨 한도에서 멈추게 한다.
   * 삭제가 필요 없는 키(활성·이미 삭제·한도 도달)는 토스를 호출하지 않고 SKIPPED.
   */
  async deleteOne(billingKeyId: string): Promise<'DELETED' | 'FAILED' | 'SKIPPED'> {
    let result: TossDeleteResult | null = null;
    try {
      const key = await this.billingKeys.findOneBy({ billingKeyId });
      if (!key?.needsPgDeletion) return 'SKIPPED';

      const credential = await this.serviceService.getActivePgCredential(key.serviceId);
      result = await this.toss.deleteBillingKey({
        secretKey: this.encryption.decrypt(credential.secretKeyEnc, credential.secretKeyId),
        billingKey: this.encryption.decrypt(key.billingKeyEnc, key.billingKeyKeyId),
      });
      if (result.outcome !== 'DELETED') {
        this.logger.warn('빌링키 ' + billingKeyId + ' 토스 삭제 실패: ' + describe(result));
      }
    } catch (error) {
      this.logger.error('빌링키 ' + billingKeyId + ' 토스 삭제 실패: ' + errorMessage(error));
    }

    try {
      return await this.recordResult(billingKeyId, result);
    } catch (error) {
      this.logger.error('빌링키 ' + billingKeyId + ' 토스 삭제 결과 기록 실패: ' + errorMessage(error));
      return 'FAILED';
    }
  }

  /** @param result null = 토스 호출 전 예외 (실패 시도로 기록) */
  @Transactional()
  private async recordResult(
    billingKeyId: string,
    result: TossDeleteResult | null,
  ): Promise<'DELETED' | 'FAILED' | 'SKIPPED'> {
    const key = await this.billingKeys.findOne({ where: { billingKeyId }, lock: { mode: 'pessimistic_write' } });
    if (!key?.needsPgDeletion) return 'SKIPPED';

    if (result?.outcome === 'DELETED') {
      key.markPgDeleted(new Date());
    } else {
      key.recordPgDeleteFailure();
      if (!key.needsPgDeletion) {
        this.logger.error(
          '빌링키 ' +
            billingKeyId +
            ' 토스 삭제 시도 한도(' +
            BILLING_KEY_PG_DELETE_MAX_ATTEMPTS +
            '회) 도달 — 수동 확인 필요',
        );
      }
    }
    // save가 updated_at을 갱신해 다음 시도 순서의 뒤로 간다
    await this.billingKeys.save(key);
    return result?.outcome === 'DELETED' ? 'DELETED' : 'FAILED';
  }
}

/** 로그용 요약. 빌링키·시크릿 키는 넣지 않는다 */
const describe = (result: Exclude<TossDeleteResult, { outcome: 'DELETED' }>): string =>
  result.outcome === 'REJECTED' ? `REJECTED ${result.code}` : `UNKNOWN ${result.reason}`;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
