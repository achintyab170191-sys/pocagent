// Bundles the API into dist/api/server.mjs (workspace packages inlined via tsconfig paths, npm packages left external)
// and copies the runtime assets that modules resolve relative to their own location: prompts/ and migrations/.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/api', { recursive: true });
await build({
  entryPoints: ['apps/api/src/server.ts'],
  outfile: 'dist/api/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  tsconfig: 'tsconfig.json',
  sourcemap: true,
  logLevel: 'info',
  // import.meta.url-relative lookups in the bundled file resolve to dist/api/../<asset>
});
cpSync('packages/agent-runtime/prompts', 'dist/prompts', { recursive: true });
cpSync('packages/persistence/migrations', 'dist/migrations', { recursive: true });
console.log('API bundle written to dist/api/server.mjs (run with: node dist/api/server.mjs)');
