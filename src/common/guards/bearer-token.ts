import { Request } from 'express';

/** `Authorization: Bearer <token>`에서 토큰만 꺼낸다. 형식이 다르면 null */
export const extractBearerToken = (req: Request): string | null => {
  const [scheme, token] = (req.header('authorization') ?? '').split(' ');
  return scheme === 'Bearer' && token ? token : null;
};
