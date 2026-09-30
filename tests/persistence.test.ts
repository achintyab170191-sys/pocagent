import { describe, expect, it } from 'vitest';
import { type UtilityResult } from '@sbo/domain';
import { createToolbox, evaluateCase, executeUtility, submitTextEvidence, resolveEvidenceAndContinue, utilityCatalog } from '@sbo/workflows';
import { newStore, resolved, ScriptedRuntime } from '@sbo/testkit';

function result(checkType: string, status = 'PASS', overrides: Partial<UtilityResult> = {}): UtilityResult {
  const entry = utilityCatalog.find((candidate) => candidate.checkType === checkType);
  return { resultId: `RES-T-${entry?.sequence}`, caseRunId: 'AUTH-001', submissionVersion: 1, sequence: entry?.sequence ?? 0, agentId: 'SBO.T', utilityName: checkType, checkType, status, findings: {}, reasonCodes: [], evidenceReferences: [], confidence: 1, humanReviewRequired: false, recommendedNextStep: '', ruleIds: [], ruleStatusUsed: 'CONFIRMED_POC', isTerminal: false, terminalOutcome: 'CONTINUE', prototypeData: true, superseded: false, createdAt: new Date().toISOString(), ...overrides };
}

describe('runtime result persistence contract (case_run_id + submission_version + check_type)', () => {
  it('one utility cannot overwrite another utility’s row (the repeated-SYSTEM_DATA_CHECK defect)', async () => {
    const store = newStore();
    await store.upsertUtilityResult(result('DOCUMENT_EXTRACTION'));
    await store.upsertUtilityResult(result('BUSINESS_VALIDATION'));
    await store.upsertUtilityResult(result('SYSTEM_DATA_CHECK'));
    const rows = await store.getRuntimeResults('AUTH-001', 1);
    expect(rows.map((row) => row.checkType)).toEqual(['DOCUMENT_EXTRACTION', 'BUSINESS_VALIDATION', 'SYSTEM_DATA_CHECK']);
  });

  it('rerunning the same utility is idempotent: one row, latest content wins', async () => {
    const store = newStore();
    await executeUtility(store, { caseRunId: 'AUTH-001', submissionVersion: 1, checkType: 'BUSINESS_VALIDATION' });
    await executeUtility(store, { caseRunId: 'AUTH-001', submissionVersion: 1, checkType: 'BUSINESS_VALIDATION' });
    const rows = await store.getRuntimeResults('AUTH-001', 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ checkType: 'BUSINESS_VALIDATION', status: 'PASS', ruleIds: ['REG-001'] });
  });

  it('key includes submission_version: the same case and check at two versions coexist', async () => {
    const store = newStore();
    await store.upsertUtilityResult(result('DOCUMENT_EXTRACTION', 'FAIL'));
    await store.upsertUtilityResult(result('DOCUMENT_EXTRACTION', 'PASS', { submissionVersion: 2 }));
    expect((await store.getRuntimeResults('AUTH-001', 1)).map((row) => row.status)).toEqual(['FAIL']);
    expect((await store.getRuntimeResults('AUTH-001', 2)).map((row) => row.status)).toEqual(['PASS']);
  });

  it('key includes case_run_id: different cases never collide', async () => {
    const store = newStore();
    await store.upsertUtilityResult(result('DOCUMENT_EXTRACTION'));
    await store.upsertUtilityResult(result('DOCUMENT_EXTRACTION', 'FAIL', { caseRunId: 'AUTH-002' }));
    expect((await store.getRuntimeResults('AUTH-001', 1))[0]?.status).toBe('PASS');
    expect((await store.getRuntimeResults('AUTH-002', 1))[0]?.status).toBe('FAIL');
  });

  it('seven checks remain seven unique check types for a clean case', async () => {
    const store = newStore();
    const caseRecord = (await store.getCase('AUTH-001'))!;
    const toolbox = createToolbox(store, caseRecord);
    for (const tool of toolbox.tools) expect((await toolbox.call(tool.name)).allowed).toBe(true);
    const rows = await store.getRuntimeResults('AUTH-001', 1);
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.checkType)).size).toBe(7);
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('evidence resolution intentionally replaces only the originating check', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([resolved]);
    const initial = await evaluateCase(store, runtime, 'AUTH-003', 's');
    const before = await store.getRuntimeResults('AUTH-003', 1);
    expect(before.find((row) => row.checkType === 'AUTHORITY_VALIDATION')).toMatchObject({ status: 'INCONCLUSIVE', ruleIds: ['AUTH-004'] });
    await submitTextEvidence(store, initial.evidenceRequest!.evidenceRequestId, { text: 'The signed authority letter grants account management, service ordering and contract approval.' });
    await resolveEvidenceAndContinue(store, runtime, initial.evidenceRequest!.evidenceRequestId, 'AUTH-003', 1);
    const after = await store.getRuntimeResults('AUTH-003', 1);
    const authority = after.find((row) => row.checkType === 'AUTHORITY_VALIDATION')!;
    expect(authority).toMatchObject({ status: 'PASS', ruleIds: ['EVID-001'], agentId: 'SBO.02', utilityName: 'Evidence Resolution Utility' });
    expect(after.filter((row) => row.checkType === 'AUTHORITY_VALIDATION')).toHaveLength(1);
    for (const type of ['DOCUMENT_EXTRACTION', 'BUSINESS_VALIDATION', 'IDENTITY_VALIDATION']) {
      expect(after.find((row) => row.checkType === type)).toEqual(before.find((row) => row.checkType === type));
    }
  });

  it('the chat-entry reset deletes only the exact case_run_id + submission_version rows', async () => {
    const store = newStore();
    await store.upsertUtilityResult(result('DOCUMENT_EXTRACTION'));
    await store.upsertUtilityResult(result('DOCUMENT_EXTRACTION', 'PASS', { submissionVersion: 2 }));
    await store.upsertUtilityResult(result('DOCUMENT_EXTRACTION', 'PASS', { caseRunId: 'AUTH-002' }));
    await store.deleteRuntimeResults('AUTH-001', 1);
    expect(await store.getRuntimeResults('AUTH-001', 1)).toEqual([]);
    expect(await store.getRuntimeResults('AUTH-001', 2)).toHaveLength(1);
    expect(await store.getRuntimeResults('AUTH-002', 1)).toHaveLength(1);
  });

  it('a failed transaction leaves no partial runtime state', async () => {
    const store = newStore();
    await expect(store.transaction(async (transaction) => { await transaction.upsertUtilityResult(result('DOCUMENT_EXTRACTION')); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await store.getRuntimeResults('AUTH-001', 1)).toEqual([]);
  });

  it('reset:runtime semantics — clears runtime state only; fixtures, rules and templates survive', async () => {
    const store = newStore();
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-001', 's');
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-004', 's');
    const rulesBefore = await store.getRules();
    await store.resetRuntime();
    for (const id of ['AUTH-001', 'AUTH-004']) {
      expect(await store.getRuntimeResults(id, 1)).toEqual([]);
      expect(await store.getDecision(id)).toBeUndefined();
      expect(await store.getRuntimeCase(id)).toBeUndefined();
      expect(await store.getCommunications(id)).toEqual([]);
      expect(await store.getAudit(id)).toEqual([]);
      expect(await store.getReviews(id)).toEqual([]);
    }
    expect(await store.getRules()).toEqual(rulesBefore);
    expect((await store.getMockResults('AUTH-001'))).toHaveLength(7);
    expect(await store.getTemplate('TPL-NMI')).toBeDefined();
    expect(await store.listCases()).toHaveLength(11);
  });

  it('clean reset and rerun of the same AUTH case gives the same governed result', async () => {
    const store = newStore();
    const first = await evaluateCase(store, new ScriptedRuntime(), 'AUTH-005', 's');
    await store.resetRuntime();
    const second = await evaluateCase(store, new ScriptedRuntime(), 'AUTH-005', 's');
    expect(second.decision).toMatchObject({ outcome: first.decision.outcome, primaryReasonCode: first.decision.primaryReasonCode, appliedRuleId: first.decision.appliedRuleId, decisionId: first.decision.decisionId });
    expect(second.assessmentCycle).toBe('INITIAL');
    expect(await store.getRuntimeResults('AUTH-005', 1)).toHaveLength(5);
  });

  it('re-evaluating a case resets first (source entry path): a second Evaluate is INITIAL again, not a no-op resume', async () => {
    const store = newStore();
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-001', 's');
    const again = await evaluateCase(store, new ScriptedRuntime(), 'AUTH-001', 's');
    expect(again.assessmentCycle).toBe('INITIAL');
    expect(again.trace).toHaveLength(7);
    const rows = await store.getRuntimeResults('AUTH-001', 1);
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.checkType)).size).toBe(7);
    expect((await store.getCommunications('AUTH-001'))).toHaveLength(1);
  });
});

describe('toolbox (the agent’s only capability)', () => {
  it('exposes exactly the seven specialist tools and nothing else', async () => {
    const store = newStore();
    const toolbox = createToolbox(store, (await store.getCase('AUTH-001'))!);
    expect(toolbox.tools.map((tool) => tool.name)).toEqual(['Document Checks', 'Business Validation', 'Identity Validation', 'Authority Validation', 'System Data Check', 'Financial Check', 'Final Verification']);
    expect(await toolbox.call('Delete Everything')).toMatchObject({ allowed: false, message: 'UNKNOWN_TOOL:Delete Everything' });
  });

  it('refuses to skip an incomplete earlier check and persists nothing', async () => {
    const store = newStore();
    const toolbox = createToolbox(store, (await store.getCase('AUTH-001'))!);
    const refused = await toolbox.call('Financial Check');
    expect(refused).toMatchObject({ allowed: false });
    expect(refused.message).toContain('EARLIER_CHECK_INCOMPLETE:DOCUMENT_EXTRACTION');
    expect(await store.getRuntimeResults('AUTH-001', 1)).toEqual([]);
  });

  it('never repeats a passed check', async () => {
    const store = newStore();
    const toolbox = createToolbox(store, (await store.getCase('AUTH-001'))!);
    expect((await toolbox.call('Document Checks')).allowed).toBe(true);
    const repeat = await toolbox.call('Document Checks');
    expect(repeat.allowed).toBe(false);
    expect(repeat.message).toContain('already has a passing result');
    expect(await store.getRuntimeResults('AUTH-001', 1)).toHaveLength(1);
  });

  it('stops after a terminal result: later tools are refused', async () => {
    const store = newStore();
    const toolbox = createToolbox(store, (await store.getCase('AUTH-004'))!);
    await toolbox.call('Document Checks');
    const business = await toolbox.call('Business Validation');
    expect(business.result).toMatchObject({ is_terminal: true, terminal_outcome: 'REJECT', status: 'FAIL' });
    const next = await toolbox.call('Identity Validation');
    expect(next).toMatchObject({ allowed: false });
    expect(next.message).toContain('TERMINAL_RESULT_ALREADY_RETURNED');
    expect(await store.getRuntimeResults('AUTH-004', 1)).toHaveLength(2);
  });

  it('returns the source-equivalent typed utility result fields', async () => {
    const store = newStore();
    const toolbox = createToolbox(store, (await store.getCase('AUTH-001'))!);
    const observation = await toolbox.call('Document Checks');
    expect(Object.keys(observation.result ?? {}).sort()).toEqual(['agent_id', 'case_run_id', 'check_type', 'confidence', 'evidence_references', 'findings', 'human_review_required', 'is_terminal', 'prototype_data', 'reason_codes', 'recommended_next_step', 'rule_ids', 'rule_status_used', 'sequence', 'status', 'submission_version', 'terminal_outcome', 'utility_name']);
  });
});
