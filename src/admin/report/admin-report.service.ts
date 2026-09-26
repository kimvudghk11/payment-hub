import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { ReportGroupBy, RevenueReportResponseDto, RevenueRowDto, RevenueTotalDto } from './admin-report.dto';

const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

interface RawRow {
  serviceId: string;
  period: string;
  currency: string;
  revenue: string;
  refund: string;
  paymentCount: string;
  cancelCount: string;
}

/**
 * 매출·환불 집계. 별도 집계 테이블 없이 원장(tb_ledger_entry)에서 계산한다 (CLAUDE.md 4장).
 * 날짜 경계는 KST — 사건 시각(토스 승인·취소 시각)을 Asia/Seoul로 바꿔 일·월로 묶는다.
 */
@Injectable()
export class AdminReportService {
  constructor(private readonly dataSource: DataSource) {}

  async revenue(query: {
    from: string;
    to: string;
    groupBy?: ReportGroupBy;
    serviceId?: string;
  }): Promise<RevenueReportResponseDto> {
    assertRange(query.from, query.to);
    const monthly = query.groupBy === 'month';

    const params: unknown[] = [monthly ? 'month' : 'day', monthly ? 'YYYY-MM' : 'YYYY-MM-DD', query.from, query.to];
    let serviceFilter = '';
    if (query.serviceId) {
      params.push(query.serviceId);
      serviceFilter = 'AND t.service_id = $5';
    }
    const raw = await this.dataSource.query<RawRow[]>(
      `SELECT t.service_id AS "serviceId",
              to_char(date_trunc($1, t.occurred_at AT TIME ZONE 'Asia/Seoul'), $2) AS period,
              e.currency,
              COALESCE(SUM(e.amount) FILTER (WHERE a.code = 'REVENUE' AND e.direction = 'CREDIT'), 0) AS revenue,
              COALESCE(SUM(e.amount) FILTER (WHERE a.code = 'REFUND' AND e.direction = 'DEBIT'), 0) AS refund,
              COUNT(DISTINCT t.id) FILTER (WHERE t.transaction_type = 'PAYMENT_CAPTURED') AS "paymentCount",
              COUNT(DISTINCT t.id) FILTER (WHERE t.transaction_type = 'PAYMENT_CANCELED') AS "cancelCount"
         FROM tb_ledger_transaction t
         JOIN tb_ledger_entry e ON e.transaction_id = t.id
         JOIN tb_ledger_account a ON a.id = e.account_id
        WHERE t.transaction_type IN ('PAYMENT_CAPTURED', 'PAYMENT_CANCELED')
          AND t.occurred_at >= ($3::date)::timestamp AT TIME ZONE 'Asia/Seoul'
          AND t.occurred_at < ($4::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul'
          ${serviceFilter}
        GROUP BY 1, 2, 3
        ORDER BY 2, 1, 3`,
      params,
    );

    const rows = raw.map((row) => {
      const revenue = toAmount(row.revenue);
      const refund = toAmount(row.refund);
      return Object.assign(new RevenueRowDto(), {
        serviceId: row.serviceId,
        period: row.period,
        currency: row.currency,
        revenue,
        refund,
        net: revenue - refund,
        paymentCount: Number(row.paymentCount),
        cancelCount: Number(row.cancelCount),
      });
    });
    return { rows, totals: totalsByCurrency(rows) };
  }
}

const invalid = (field: string, message: string) =>
  new BusinessException(ErrorCode.INVALID_REQUEST, { errors: [{ field, message }] });

const assertRange = (from: string, to: string): void => {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start)) throw invalid('from', 'from은 존재하는 날짜여야 합니다.');
  if (Number.isNaN(end)) throw invalid('to', 'to는 존재하는 날짜여야 합니다.');
  if (start > end) throw invalid('from', 'from은 to보다 늦을 수 없습니다.');
  if ((end - start) / DAY_MS + 1 > MAX_RANGE_DAYS) throw invalid('to', `기간은 최대 ${MAX_RANGE_DAYS}일입니다.`);
};

/** pg SUM(bigint)은 numeric 문자열 — 안전 정수 범위를 넘으면 정밀도 손실 대신 실패 */
const toAmount = (value: string): number => {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error(`집계 금액이 안전 정수 범위를 넘었습니다: ${value}`);
  return amount;
};

const totalsByCurrency = (rows: RevenueRowDto[]): RevenueTotalDto[] => {
  const totals = new Map<string, RevenueTotalDto>();
  for (const row of rows) {
    const total = totals.get(row.currency) ?? { currency: row.currency, revenue: 0, refund: 0, net: 0 };
    total.revenue += row.revenue;
    total.refund += row.refund;
    total.net += row.net;
    totals.set(row.currency, total);
  }
  return [...totals.values()];
};
