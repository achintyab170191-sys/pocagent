/**
 * Test-only API server for the Playwright specs: in-memory persistence and the deterministic agent runtime (no model). The five checks, the
 * registers and the evidence loop are the real code; only the persistence and the SBO.02 language model are replaced.
 * Never used outside tests (production wiring is apps/api/src/server.ts).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicAgentRuntime } from '@sbo/agent-runtime';
import { newStore } from '@sbo/testkit';
import { buildApp } from '../../apps/api/src/app.js';

const port = Number(process.env.E2E_API_PORT ?? 3100);
const app = await buildApp({
  repository: newStore(),
  agentRuntime: new DeterministicAgentRuntime(),
  config: { appBaseUrl: process.env.E2E_APP_URL ?? 'http://localhost:5273', sessionSecret: 'e2e-secret-e2e-secret-e2e-secret-12345', uploadDirectory: mkdtempSync(join(tmpdir(), 'sbo-e2e-')), rateLimit: { global: 100_000, strict: 100_000, upload: 100_000 } },
});
await app.listen({ port, host: '127.0.0.1' });
console.log(`E2E API listening on ${port}`);