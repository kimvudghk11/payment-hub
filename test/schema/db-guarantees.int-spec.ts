import { randomUUID } from 'crypto';
import { QueryFailedError } from 'typeorm';
import { PayableService, onboardPayableService } from '../support/admin-fixtures';
import { IntegrationApp, createIntegrationApp, dataOf } from '../support/integration-app';

/** PostgreSQL 에러 코드 */
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
/** plpgsql RAISE EXCEPTION 기본 코드 (원장 트리거) */
const RAISE_EXCEPTION = 'P0001';

interface PgError {
  code: string;
  constraint?: string;
  message: string;
}

/** 쿼리가 DB에서 거부됐는지 — 앱 코드가 아니라 DB가 막았다는 것을 에러 코드·제약 이름으로 확인한다 */
const rejectionOf = async (work: Promise<unknown>): Promise<PgError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof QueryFailedError) {
      const driverError = error.driverError as PgError;
      return { code: driverError.code, constraint: driverError.constraint, message: driverError.message };
    }
    throw error;
  }
  throw new Error('DB가 거부해야 하는 쿼리가 성공했습니다');
};

let seq = 0;

/**
 * 앱 코드가 아니라 DB 스키마(db/schema.sql)가 스스로 지키는 보장.
 * 코드에 버그가 있거나 누군가 SQL을 직접 실행해도 깨지면 안 되는 규칙이므로, 앱을 거치지 않고 SQL로 직접 확인한다.
 */
describe('DB가 강제하는 보장 (schema.sql)', () => {
  let ctx: IntegrationApp;
  let serviceA: PayableService;
  let serviceB: PayableService;

  const createOrder = async (service: PayableService): Promise<string> => {
    const res = await ctx
      .http()
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${service.apiKey}`)
      .send({
        externalOrderId: `db-guarantee-${Date.now()}-${seq++}`,
        externalUserId: 'user-db',
        orderName: '프로 요금제',
        items: [{ productType: 'PLAN', externalProductId: 'pro', productName: '프로', unitPrice: 10000, quantity: 1 }],
        totalAmount: 10000,
      });
    if (res.status !== 201) throw new Error(`주문 등록 실패: ${res.status} ${JSON.stringify(res.body)}`);
    return dataOf<{ orderId: string }>(res).orderId;
  };

  const insertPayment = (params: { orderId: string; serviceId: string; status?: string }) =>
    ctx.dataSource.query<{ id: string }[]>(
      `INSERT INTO tb_payment (order_id, service_id, payment_type, idempotency_key, currency, amount, status)
       VALUES ($1, $2, 'NORMAL', $3, 'KRW', 10000, $4) RETURNING id`,
      [params.orderId, params.serviceId, `db-guarantee-${seq++}`, params.status ?? 'IN_PROGRESS'],
    );

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    serviceA = await onboardPayableService(ctx);
    serviceB = await onboardPayableService(ctx);
  });
  afterAll(() => ctx.app.close());

  describe('원장 — 복식부기·append-only', () => {
    let debitAccountId: string;
    let creditAccountId: string;

    const insertAccount = async (code: string, type: string): Promise<string> => {
      const [row] = await ctx.dataSource.query<{ id: string }[]>(
        `INSERT INTO tb_ledger_account (service_id, code, type, currency) VALUES ($1, $2, $3, 'KRW') RETURNING id`,
        [serviceA.serviceId, code, type],
      );
      return row.id;
    };

    /** 한 트랜잭션에서 분개를 넣고 커밋한다. 차대 균형은 커밋 시점(DEFERRED 제약 트리거)에 검사된다 */
    const book = async (debit: number, credit: number, referenceId: string = randomUUID()): Promise<string> => {
      const runner = ctx.dataSource.createQueryRunner();
      await runner.connect();
      const transactionId = randomUUID();
      try {
        await runner.startTransaction();
        await runner.query(
          `INSERT INTO tb_ledger_transaction (id, service_id, transaction_type, reference_type, reference_id, occurred_at)
           VALUES ($1, $2, 'ADJUSTMENT', 'PAYMENT', $3, now())`,
          [transactionId, serviceA.serviceId, referenceId],
        );
        await runner.query(
          `INSERT INTO tb_ledger_entry (transaction_id, account_id, direction, amount, currency)
           VALUES ($1, $2, 'DEBIT', $3, 'KRW'), ($1, $4, 'CREDIT', $5, 'KRW')`,
          [transactionId, debitAccountId, debit, creditAccountId, credit],
        );
        await runner.commitTransaction();
        return transactionId;
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    };

    const countTransactions = async (referenceId: string): Promise<number> => {
      const [row] = await ctx.dataSource.query<{ count: string }[]>(
        'SELECT count(*) FROM tb_ledger_transaction WHERE reference_id = $1',
        [referenceId],
      );
      return Number(row.count);
    };

    beforeAll(async () => {
      debitAccountId = await insertAccount('DBG_RECEIVABLE', 'ASSET');
      creditAccountId = await insertAccount('DBG_REVENUE', 'REVENUE');
    });

    it('차변 합 = 대변 합이면 커밋된다 (대조군)', async () => {
      const referenceId = randomUUID();
      await book(10000, 10000, referenceId);
      expect(await countTransactions(referenceId)).toBe(1);
    });

    it('차변 합 ≠ 대변 합이면 커밋 시점에 거부되고 아무것도 남지 않는다', async () => {
      const referenceId = randomUUID();

      const error = await rejectionOf(book(10000, 9000, referenceId));

      expect(error.code).toBe(RAISE_EXCEPTION);
      expect(error.message).toMatch(/unbalanced: debit=10000 credit=9000/);
      expect(await countTransactions(referenceId)).toBe(0);
    });

    it('같은 사건(transaction_type, reference_type, reference_id)은 두 번 기장할 수 없다', async () => {
      const referenceId = randomUUID();
      await book(10000, 10000, referenceId);

      const error = await rejectionOf(book(10000, 10000, referenceId));

      expect(error).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'uq_tb_ledger_transaction_ref' });
      expect(await countTransactions(referenceId)).toBe(1);
    });

    it.each([
      ['분개 금액 수정', `UPDATE tb_ledger_entry SET amount = 1 WHERE transaction_id = $1`],
      ['분개 삭제', `DELETE FROM tb_ledger_entry WHERE transaction_id = $1`],
      ['거래 수정', `UPDATE tb_ledger_transaction SET description = '조작' WHERE id = $1`],
      ['거래 삭제', `DELETE FROM tb_ledger_transaction WHERE id = $1`],
    ])('%s은 트리거로 거부된다 (정정은 ADJUSTMENT 반대 분개로만)', async (_, sql) => {
      const transactionId = await book(10000, 10000);

      const error = await rejectionOf(ctx.dataSource.query(sql, [transactionId]));

      expect(error.code).toBe(RAISE_EXCEPTION);
      expect(error.message).toMatch(/append-only/);
      const [entry] = await ctx.dataSource.query<{ total: string }[]>(
        'SELECT sum(amount) AS total FROM tb_ledger_entry WHERE transaction_id = $1',
        [transactionId],
      );
      expect(Number(entry.total)).toBe(20000);
    });
  });

  describe('감사 로그 — append-only', () => {
    it.each([
      ['수정', `UPDATE tb_admin_audit_log SET actor_id = 'someone-else' WHERE service_id = $1`],
      ['삭제', `DELETE FROM tb_admin_audit_log WHERE service_id = $1`],
    ])('관리 작업 기록 %s는 트리거로 거부된다', async (_, sql) => {
      const error = await rejectionOf(ctx.dataSource.query(sql, [serviceA.serviceId]));

      expect(error.code).toBe(RAISE_EXCEPTION);
      expect(error.message).toMatch(/tb_admin_audit_log is append-only/);
    });
  });

  describe('서비스 소유권 — (id, service_id) 복합 FK', () => {
    it('다른 서비스의 주문에 결제를 붙일 수 없다', async () => {
      const orderOfA = await createOrder(serviceA);

      const error = await rejectionOf(insertPayment({ orderId: orderOfA, serviceId: serviceB.serviceId }));

      expect(error).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'fk_tb_payment_order' });
    });

    it('다른 서비스의 결제에 취소를 붙일 수 없다', async () => {
      const [paymentOfA] = await insertPayment({
        orderId: await createOrder(serviceA),
        serviceId: serviceA.serviceId,
        status: 'DONE',
      });

      const error = await rejectionOf(
        ctx.dataSource.query(
          `INSERT INTO tb_payment_cancel (payment_id, service_id, idempotency_key, amount, reason_code, requested_by)
           VALUES ($1, $2, $3, 1000, 'TEST', 'SERVICE')`,
          [paymentOfA.id, serviceB.serviceId, `db-guarantee-cancel-${seq++}`],
        ),
      );

      expect(error).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'fk_tb_payment_cancel_payment' });
    });
  });

  describe('이중 결제 방지 — 주문당 살아있는 결제 1건 (부분 유니크 인덱스)', () => {
    it('진행 중인 결제가 있는 주문에 결제를 하나 더 만들 수 없다', async () => {
      const orderId = await createOrder(serviceA);
      await insertPayment({ orderId, serviceId: serviceA.serviceId });

      const error = await rejectionOf(insertPayment({ orderId, serviceId: serviceA.serviceId }));

      expect(error).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'uq_tb_payment_one_live_per_order' });
    });

    it.each(['FAILED', 'ABORTED', 'EXPIRED'])(
      '끝난 결제(%s)만 있으면 새 결제를 만들 수 있다 (대조군)',
      async (status) => {
        const orderId = await createOrder(serviceA);
        await insertPayment({ orderId, serviceId: serviceA.serviceId, status });

        await expect(insertPayment({ orderId, serviceId: serviceA.serviceId })).resolves.toHaveLength(1);
      },
    );
  });
});
