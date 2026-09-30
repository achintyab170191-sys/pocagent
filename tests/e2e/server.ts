/**
 * Test-only API server for the Playwright specs: in-memory persistence over the preserved source fixtures and a test-double agent runtime.
 * The evidence "model" is keyword-driven so browser tests are deterministic: text containing CONTRADICT → EVID-003, PARTIAL → EVID-002, else EVID-001.
 * Never used outside tests (production wiring is apps/api/src/server.ts).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicAgentRuntime, type EvidenceResolutionRequest } from '@sbo/agent-runtime';
import { type EvidenceResolution } from '@sbo/domain';
import { newStore, contradictory, insufficient, resolved } from '@sbo/testkit';
import { buildApp } from '../../apps/api/src/app.js';

class KeywordRuntime extends DeterministicAgentRuntime {
  public override async resolveEvidence(request: EvidenceResolutionRequest): Promise<EvidenceResolution> {
    const text = JSON.stringify(request.evidenceRecords).toUpperCase();
    if (text.includes('CONTRADICT')) return contradictory;
    if (text.includes('PARTIAL')) return insufficient;
    return resolved;
  }
}

const port = Number(process.env.E2E_API_PORT ?? 3100);
const app = await buildApp({
  repository: newStore(),
  agentRuntime: new KeywordRuntime(),
  config: { appBaseUrl: process.env.E2E_APP_URL ?? 'http://localhost:5273', sessionSecret: 'e2e-secret-e2e-secret-e2e-secret-12345', uploadDirectory: mkdtempSync(join(tmpdir(), 'sbo-e2e-')), rateLimit: { global: 100_000, strict: 100_000 } },
});
await app.listen({ port, host: '127.0.0.1' });
console.log(`E2E API listening on ${port}`);
