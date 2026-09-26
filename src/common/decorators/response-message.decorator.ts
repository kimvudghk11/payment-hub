import { SetMetadata } from '@nestjs/common';

export const RESPONSE_MESSAGE_KEY = 'responseMessage';

/** 성공 응답의 message. 모든 핸들러에 붙인다 (CLAUDE.md 8장 컨트롤러) */
export const ResponseMessage = (message: string) => SetMetadata(RESPONSE_MESSAGE_KEY, message);
