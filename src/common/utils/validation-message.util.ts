/**
 * class-validator 한국어 메시지 공통 함수. DTO는 메시지를 직접 쓰지 않고 이 함수를 사용한다.
 * 예: @IsNotEmpty({ message: ValidationMessage.required('code') }) → 'code는 필수입니다.'
 */

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;
// 영문 필드명을 한국어로 읽었을 때 받침으로 끝나는 끝 글자 (label → 레이블, reason → 리즌, type → 타입).
// 소리 나지 않는 끝 e는 빼고 본다 (name → 네임, code → 코드)
const LATIN_FINAL_CONSONANT = /[lmnp]e?$/i;

/** 은/는 */
const topic = (field: string): string => {
  const last = field.charCodeAt(field.length - 1);
  const hasFinalConsonant =
    last >= HANGUL_START && last <= HANGUL_END ? (last - HANGUL_START) % 28 !== 0 : LATIN_FINAL_CONSONANT.test(field);
  return `${field}${hasFinalConsonant ? '은' : '는'}`;
};

export const ValidationMessage = {
  required: (field: string) => `${topic(field)} 필수입니다.`,
  string: (field: string) => `${topic(field)} 문자열이어야 합니다.`,
  boolean: (field: string) => `${topic(field)} true 또는 false여야 합니다.`,
  integer: (field: string) => `${topic(field)} 정수여야 합니다.`,
  positive: (field: string) => `${topic(field)} 0보다 커야 합니다.`,
  min: (field: string, min: number) => `${topic(field)} ${min} 이상이어야 합니다.`,
  max: (field: string, max: number) => `${topic(field)} ${max} 이하여야 합니다.`,
  maxLength: (field: string, max: number) => `${topic(field)} ${max}자 이하여야 합니다.`,
  httpUrl: (field: string) => `${topic(field)} http(s) URL이어야 합니다.`,
  dateString: (field: string) => `${topic(field)} ISO 8601 날짜여야 합니다.`,
  uuid: (field: string) => `${topic(field)} UUID 형식이어야 합니다.`,
  oneOf: (field: string, values: readonly string[]) => `${topic(field)} ${values.join(', ')} 중 하나여야 합니다.`,
  format: (field: string, rule: string) => `${topic(field)} 형식이 올바르지 않습니다 (${rule}).`,
};
