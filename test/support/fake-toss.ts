import { randomUUID } from 'crypto';
import { IncomingHttpHeaders, Server, createServer } from 'http';
import { AddressInfo } from 'net';

export interface FakeTossRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface FakeTossResponse {
  status: number;
  body: unknown;
  /** 응답 지연 (hub 타임아웃 검증용) */
  delayMs?: number;
}

type Handler = (request: FakeTossRequest) => FakeTossResponse;

/** 카드 승인 성공 응답 (토스 Payment 객체 형태) */
export const approvedCardPayment = (request: FakeTossRequest, overrides: Record<string, unknown> = {}) => ({
  paymentKey: request.body.paymentKey,
  orderId: request.body.orderId,
  status: 'DONE',
  method: '카드',
  totalAmount: request.body.amount,
  balanceAmount: request.body.amount,
  currency: 'KRW',
  requestedAt: '2026-09-27T10:15:00+09:00',
  approvedAt: '2026-09-27T10:16:03+09:00',
  card: { issuerCode: '11', number: '433012******123*', installmentPlanMonths: 0, cardType: '신용' },
  receipt: { url: 'https://dashboard.tosspayments.com/receipt/fake' },
  ...overrides,
});

/** 취소 성공 응답: 결제 객체 + cancels 마지막에 이번 취소 (transactionKey는 실제 토스처럼 전역 유일) */
export const canceledPayment = (request: FakeTossRequest, overrides: Record<string, unknown> = {}) => ({
  paymentKey: decodeURIComponent(request.path.split('/')[3] ?? ''),
  status: 'PARTIAL_CANCELED',
  cancels: [
    {
      transactionKey: `tx_cancel_${randomUUID()}`,
      cancelAmount: request.body.cancelAmount,
      canceledAt: '2026-09-28T09:00:00+09:00',
    },
  ],
  ...overrides,
});

/**
 * 테스트용 토스 API 서버. 실제 HTTP로 hub의 토스 클라이언트(인증 헤더·타임아웃·에러 분류)를 검증한다.
 * 기본 응답은 카드 승인 성공. respond()로 다음 요청들의 응답을 바꾼다.
 */
export class FakeToss {
  readonly requests: FakeTossRequest[] = [];
  private handler: Handler = (request) => ({ status: 200, body: approvedCardPayment(request) });
  private server?: Server;

  respond(handler: Handler): void {
    this.handler = handler;
  }

  reset(): void {
    this.requests.length = 0;
    this.handler = (request) => ({ status: 200, body: approvedCardPayment(request) });
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const request: FakeTossRequest = {
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        };
        this.requests.push(request);
        const response = this.handler(request);
        const send = () => {
          if (res.destroyed) return;
          res.writeHead(response.status, { 'Content-Type': 'application/json' });
          res.end(typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
        };
        if (response.delayMs) setTimeout(send, response.delayMs);
        else send();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
