import { IncomingHttpHeaders, Server, createServer } from 'http';
import { AddressInfo } from 'net';

export interface ReceivedWebhook {
  headers: IncomingHttpHeaders;
  /** 서명 검증은 원문 본문으로 한다 */
  rawBody: string;
}

/** 서비스의 웹훅 수신 서버 역할. 받은 요청을 기록하고 정해 둔 status로 응답한다 */
export class FakeWebhookReceiver {
  readonly received: ReceivedWebhook[] = [];
  status = 200;
  /** start() 후 수신 URL */
  webhookUrl = '';
  private server?: Server;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.received.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(this.status, { 'Content-Type': 'text/plain' });
        res.end(this.status < 300 ? 'ok' : 'error from service');
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.webhookUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/webhooks/payment-hub`;
    return this.webhookUrl;
  }

  reset(): void {
    this.received.length = 0;
    this.status = 200;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
