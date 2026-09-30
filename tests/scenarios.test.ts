import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyDocument, guidedScenarios, scenarioReferenceDate, type GuidedScenario, type ScenarioFile } from '@sbo/domain';
import { handleChatEvidenceUpload, handleChatMessage, listGuidedScenarios } from '@sbo/workflows';
import { newStore, ScriptedRuntime } from '@sbo/testkit';
import { extractDocumentText } from '../apps/api/src/documents.js';

const samples = join('apps', 'web', 'public', 'samples');
const pathOf = (scenario: GuidedScenario, file: ScenarioFile): string => file.existing ? join(samples, file.existing) : join(samples, 'scenarios', scenario.slug, file.fileName);

// The sample files are dated from the reference date: replay them on that day.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${scenarioReferenceDate}T09:00:00Z`)); });
afterEach(() => { vi.useRealTimers(); });

describe('guided scenarios: realistic documents, flawed then corrected', () => {
  it('every scenario file exists (run `npm run samples` after changing scenarios) and is read by the real extractor as the type it claims to be', async () => {
    expect(guidedScenarios.length).toBeGreaterThanOrEqual(10);
    for (const scenario of guidedScenarios) {
      for (const file of scenario.files) {
        expect(existsSync(pathOf(scenario, file)), `${scenario.slug}/${file.fileName}`).toBe(true);
        const extracted = await extractDocumentText(readFileSync(pathOf(scenario, file)));
        expect(extracted.error, `${scenario.slug}/${file.fileName}`).toBeUndefined();
        expect(classifyDocument(extracted.text)?.documentType, `${scenario.slug}/${file.fileName}`).toBe(file.type);
      }
    }
  }, 120_000);

  it('every step of every scenario names files that belong to it', () => {
    for (const scenario of guidedScenarios) for (const step of scenario.steps) for (const name of step.upload) expect(scenario.files.some((file) => file.fileName === name), `${scenario.slug}: ${name}`).toBe(true);
  });

  it.each(guidedScenarios.map((scenario) => [scenario.slug, scenario] as const))('%s: each step ends where the script says', async (_slug, scenario) => {
    const store = newStore();
    const deps = { repository: store, agentRuntime: new ScriptedRuntime(), appBaseUrl: 'http://localhost:5173' };
    const opened = await handleChatMessage(deps, { sessionId: 's', message: `My name is ${scenario.representativeName} and I represent ${scenario.businessName}.` });
    expect(opened.step, 'the introduction opens a document request').toBe('AWAITING_EVIDENCE');
    for (const [index, step] of scenario.steps.entries()) {
      const label = `${scenario.slug} step ${index + 1} (${step.upload.join(', ')})`;
      const files = [];
      for (const name of step.upload) {
        const file = scenario.files.find((entry) => entry.fileName === name)!;
        files.push({ fileName: name, mimeType: 'application/pdf', storageUrl: 'x', extractedText: (await extractDocumentText(readFileSync(pathOf(scenario, file)))).text });
      }
      const reply = await handleChatEvidenceUpload(deps, { sessionId: 's', files });
      const said = reply.messages.join('\n');
      expect(reply.step, label).toBe(step.expect.step);
      if (step.expect.outcome) expect(reply.outcome, label).toMatchObject({ governedOutcome: step.expect.outcome, ...(step.expect.reason ? { primaryReasonCode: step.expect.reason } : {}) });
      else expect(reply.outcome, `${label}: no decision yet, the request stays open`).toBeUndefined();
      for (const text of step.expect.includes ?? []) expect(said, label).toContain(text);
      for (const text of step.expect.excludes ?? []) expect(said, label).not.toContain(text);
      if (step.expect.request) expect(reply.evidenceRequest, label).toMatchObject({ status: step.expect.request.status, attemptCount: step.expect.request.attempts });
    }
  }, 120_000);

  it('the scenarios are listed for the web app with their files, links and a line per step', () => {
    const listed = listGuidedScenarios();
    expect(listed.map((entry) => entry.slug)).toEqual(guidedScenarios.map((entry) => entry.slug));
    const liam = listed.find((entry) => entry.slug === 'liam-bluegum-authority-v1-v2')!;
    expect(liam.files.map((file) => file.path)).toContain('/samples/n8n-liam-chen-bluegum-vector/authority-letter-v1.pdf');
    expect(liam.steps.map((step) => step.expect)).toEqual(['Asks for more: POA_MOA_MISSING', expect.stringContaining('Still insufficient'), 'Decision: APPROVE (ALL_CHECKS_PASSED)']);
    expect(listed.find((entry) => entry.slug === 'fatima-injected-card')?.files.some((file) => file.path.startsWith('/samples/scenarios/fatima-injected-card/'))).toBe(true);
  });
});
