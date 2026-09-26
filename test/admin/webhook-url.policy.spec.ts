import { assertWebhookUrlAllowed } from '../../src/admin/service/webhook-url.policy';
import { PgEnvironment } from '../../src/service/constants/service.constants';
import { expectBusinessError } from '../support/business-error';

describe('웹훅 URL 정책 (배포 환경별)', () => {
  it('LIVE는 https만 허용한다 (결제 이벤트를 평문으로 보내지 않음)', () => {
    expect(() => assertWebhookUrlAllowed(PgEnvironment.LIVE, 'https://svc.example.com/hook')).not.toThrow();
    expectBusinessError(
      () => assertWebhookUrlAllowed(PgEnvironment.LIVE, 'http://svc.example.com/hook'),
      'INVALID_REQUEST',
    );
  });

  it('TEST는 로컬 개발을 위해 http·localhost도 허용한다', () => {
    expect(() => assertWebhookUrlAllowed(PgEnvironment.TEST, 'http://localhost:4000/hook')).not.toThrow();
    expect(() => assertWebhookUrlAllowed(PgEnvironment.TEST, 'https://svc.example.com/hook')).not.toThrow();
  });

  it('URL이 없으면(웹훅 미사용) 통과한다', () => {
    expect(() => assertWebhookUrlAllowed(PgEnvironment.LIVE, null)).not.toThrow();
    expect(() => assertWebhookUrlAllowed(PgEnvironment.LIVE, undefined)).not.toThrow();
  });
});
