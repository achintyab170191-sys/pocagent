import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  resolve: { alias: { '@sbo/domain': resolve(root, 'packages/domain/src/index.ts'), '@sbo/persistence': resolve(root, 'packages/persistence/src/index.ts'), '@sbo/governance': resolve(root, 'packages/governance/src/index.ts'), '@sbo/workflows': resolve(root, 'packages/workflows/src/index.ts'), '@sbo/agent-runtime': resolve(root, 'packages/agent-runtime/src/index.ts'), '@sbo/testkit': resolve(root, 'packages/testkit/src/index.ts') } },
  // Unit + in-memory tests only. SQL tests run via `npm run test:integration`; browser tests via `npm run test:e2e`.
  test: { environment: 'node', include: ['tests/**/*.test.ts'], exclude: ['tests/**/*.integration.test.ts', 'tests/e2e/**', 'node_modules/**'] },
});
