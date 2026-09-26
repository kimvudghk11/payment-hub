import { ValidationMessage } from '../../src/common/utils/validation-message.util';

describe('ValidationMessage', () => {
  it('필드명 뒤에 받침에 맞는 조사를 붙인다 (l·m·n으로 끝나는 영문은 "은")', () => {
    expect(ValidationMessage.required('name')).toBe('name은 필수입니다.');
    expect(ValidationMessage.required('label')).toBe('label은 필수입니다.');
    expect(ValidationMessage.required('reason')).toBe('reason은 필수입니다.');
    expect(ValidationMessage.required('code')).toBe('code는 필수입니다.');
    expect(ValidationMessage.required('amount')).toBe('amount는 필수입니다.');
  });

  it('한글 필드명은 받침 유무로 조사를 고른다', () => {
    expect(ValidationMessage.required('금액')).toBe('금액은 필수입니다.');
    expect(ValidationMessage.required('사유')).toBe('사유는 필수입니다.');
  });

  it('규칙별 메시지를 만든다', () => {
    expect(ValidationMessage.string('code')).toBe('code는 문자열이어야 합니다.');
    expect(ValidationMessage.maxLength('name', 100)).toBe('name은 100자 이하여야 합니다.');
    expect(ValidationMessage.positive('amount')).toBe('amount는 0보다 커야 합니다.');
    expect(ValidationMessage.httpsUrl('webhookUrl')).toBe('webhookUrl은 https URL이어야 합니다.');
    expect(ValidationMessage.dateString('expiresAt')).toBe('expiresAt는 ISO 8601 날짜여야 합니다.');
    expect(ValidationMessage.format('code', '영문 대문자·숫자·_ 2~20자')).toBe(
      'code는 형식이 올바르지 않습니다 (영문 대문자·숫자·_ 2~20자).',
    );
  });
});
