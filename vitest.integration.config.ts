import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));
// Standalone (not merged with vitest.config.ts) so the include list is only the SQL integration tests.
export default defineConfig({
  resolve: { alias: { '@sbo/domain': resolve(root, 'packages/domain/src/index.ts'), '@sbo/persistence': resolve(root, 'packages/persistence/src/index.ts'), '@sbo/governance': resolve(root, 'packages/governance/src/index.ts'), '@sbo/workflows': resolve(root, 'packages/workflows/src/index.ts'), '@sbo/agent-runtime': resolve(root, 'packages/agent-runtime/src/index.ts'), '@sbo/testkit': resolve(root, 'packages/testkit/src/index.ts') } },
  test: { environment: 'node', include: ['tests/**/*.integration.test.ts'], testTimeout: 60_000, hookTimeout: 120_000 },
});
