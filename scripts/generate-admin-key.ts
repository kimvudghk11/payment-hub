/**
 * admin 레포 서버가 쓸 관리자 API 키를 만든다.
 *   npm run admin-key:generate
 * - 평문 키 → admin 레포 서버 환경변수에만 저장 (다시 볼 수 없음)
 * - SHA-256 해시 → hub 환경변수 ADMIN_API_KEY_HASHES에 추가 (쉼표로 여러 개 = 무중단 교체)
 */
import { createHash, randomBytes } from 'crypto';

export const generateAdminKey = (): { adminKey: string; hash: string } => {
  const adminKey = `phadm_${randomBytes(32).toString('base64url')}`;
  return { adminKey, hash: createHash('sha256').update(adminKey).digest('hex') };
};

if (require.main === module) {
  const { adminKey, hash } = generateAdminKey();
  console.log(
    [
      '',
      '관리자 API 키를 만들었습니다. 평문은 지금만 볼 수 있습니다.',
      '',
      '1) admin 레포 서버 환경변수 (평문, 외부 노출 금지)',
      `   PAYMENT_HUB_ADMIN_API_KEY=${adminKey}`,
      '',
      '2) payment-hub 환경변수 (해시만. 기존 값이 있으면 쉼표로 이어 붙임)',
      `   ADMIN_API_KEY_HASHES=${hash}`,
      '',
      '교체: 새 키 해시를 추가 → admin 레포 배포 → 구 키 해시 제거',
      '',
    ].join('\n'),
  );
}
