import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PgEnvironment } from '../../service/constants/service.constants';

/**
 * 웹훅 URL 형식(http/https URL)은 DTO가 검증하고, 배포 환경별 허용 여부는 여기서 판단한다.
 * - LIVE: https만 (결제 이벤트를 평문으로 보내지 않음)
 * - TEST: 서비스 개발자가 로컬 수신 서버(http://localhost…)로 연동할 수 있게 http도 허용
 */
export const assertWebhookUrlAllowed = (environment: PgEnvironment, webhookUrl: string | null | undefined): void => {
  if (!webhookUrl || environment !== PgEnvironment.LIVE) return;
  if (!webhookUrl.startsWith('https://')) {
    throw new BusinessException(ErrorCode.INVALID_REQUEST, {
      errors: [{ field: 'webhookUrl', message: 'LIVE 환경의 webhookUrl은 https여야 합니다.' }],
    });
  }
};
