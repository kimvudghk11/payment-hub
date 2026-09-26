import { readFileSync } from 'fs';
import { join } from 'path';
import { generateOpenApiSpec } from '../../src/openapi';

/**
 * docs/openapi.json은 연동하는 쪽(서비스·admin 레포)이 클라이언트를 생성하는 계약서다.
 * 코드와 어긋나면 실패한다 → `npm run openapi:export`로 다시 생성해 함께 커밋한다.
 */
describe('docs/openapi.json', () => {
  it('현재 코드에서 생성한 스펙과 같다', async () => {
    const committed = readFileSync(join(__dirname, '..', '..', 'docs', 'openapi.json'), 'utf8');

    const generated = await generateOpenApiSpec();

    expect(generated).toBe(committed);
  });

  it('서비스 API와 관리자 API의 인증 방식을 구분해 선언한다', async () => {
    const spec = JSON.parse(await generateOpenApiSpec()) as {
      components: { securitySchemes: Record<string, unknown> };
      paths: Record<string, Record<string, { security?: Record<string, unknown>[] }>>;
    };

    expect(Object.keys(spec.components.securitySchemes).sort()).toEqual(['admin-api-key', 'service-api-key']);
    expect(spec.paths['/api/v1/orders'].post.security).toEqual([{ 'service-api-key': [] }]);
    expect(spec.paths['/api/v1/admin/services'].post.security).toEqual([{ 'admin-api-key': [] }]);
  });
});
