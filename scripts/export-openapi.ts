import { writeFileSync } from 'fs';
import { join } from 'path';
import { generateOpenApiSpec } from '../src/openapi';

/** docs/openapi.json 생성. API를 바꾸면 실행해 함께 커밋한다 (test/docs/openapi.spec.ts가 검사) */
void generateOpenApiSpec().then((spec) => {
  const target = join(__dirname, '..', 'docs', 'openapi.json');
  writeFileSync(target, spec);
  console.log(`OpenAPI 스펙을 생성했습니다: ${target}`);
});
