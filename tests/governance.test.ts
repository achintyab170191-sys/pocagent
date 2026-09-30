import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '@sbo/persistence';
import { determineDecision, finalizeDecision, fillTemplate, parseResultSource, renderCommunication, type CheckRow } from '@sbo/governance';
import { newStore } from '@sbo/testkit';
import { mandatoryCheckTypes } from '@sbo/domain';

const store = newStore();
const rules = await store.getRules();
const caseRecord = (await store.getCase('AUTH-001'))!;

function row(checkType: string, status: string, ruleIds: string[] = [], extra: Partial<CheckRow> = {}): CheckRow {
  const sequence = mandatoryCheckTypes.indexOf(checkType as never) + 1;
  return { sequence, agentId: 'SBO.TEST', utilityName: `${checkType} tool`, checkType, status, findings: {}, reasonCodes: [], ruleIds, ...extra };
}
const allPass = mandatoryCheckTypes.map((checkType) => row(checkType, 'PASS'));

describe('Workflow 90 deterministic finalizer', () => {
  it('approves only when every mandatory check passes (FINAL-001)', () => {
    const decision = determineDecision(caseRecord, allPass, rules, 'RUNTIME');
    expect(decision).toMatchObject({ outcome: 'APPROVE', primaryReasonCode: 'ALL_CHECKS_PASSED', appliedRuleId: 'FINAL-001', governanceControlApplied: false, humanReviewRequired: false, decisionId: 'DEC-AUTH-001-1', productionWritePerformed: false, prototypeData: true });
  });

  it('treats PASS_WITH_FLAG as passing and preserves the flag in completed checks', () => {
    const rows = allPass.map((entry) => entry.checkType === 'SYSTEM_DATA_CHECK' ? row('SYSTEM_DATA_CHECK', 'PASS_WITH_FLAG', ['CRM-001']) : entry);
    const decision = determineDecision(caseRecord, rows, rules, 'RUNTIME');
    expect(decision.outcome).toBe('APPROVE');
    expect(decision.completedChecks.find((check) => check.checkType === 'SYSTEM_DATA_CHECK')?.status).toBe('PASS_WITH_FLAG');
    expect(decision.assumptionsUsed).toContain('CRM-001');
  });

  it('never approves with fewer than seven passes: one missing check → CTRL-003 MANDATORY_CHECKS_INCOMPLETE', () => {
    const decision = determineDecision(caseRecord, allPass.slice(0, 6), rules, 'RUNTIME');
    expect(decision).toMatchObject({ outcome: 'MANUAL_REVIEW', primaryReasonCode: 'MANDATORY_CHECKS_INCOMPLETE', appliedRuleId: 'CTRL-003', governanceControlApplied: true, targetQueue: 'AGENT_OPERATIONS_REVIEW' });
    expect(decision.checksNotRun).toEqual(['FINAL_VERIFICATION']);
  });

  it('treats NOT_RUN rows as absent (they neither pass nor complete a check)', () => {
    const rows = [...allPass.slice(0, 4), ...mandatoryCheckTypes.slice(4).map((checkType) => row(checkType, 'NOT_RUN'))];
    const decision = determineDecision(caseRecord, rows, rules, 'RUNTIME');
    expect(decision.primaryReasonCode).toBe('MANDATORY_CHECKS_INCOMPLETE');
    expect(decision.checksNotRun).toEqual(['SYSTEM_DATA_CHECK', 'FINANCIAL_CHECK', 'FINAL_VERIFICATION']);
    expect(decision.completedChecks).toHaveLength(4);
  });

  it('zero persisted runtime results → CTRL-002 AGENT_TOOL_RESULTS_MISSING', () => {
    expect(determineDecision(caseRecord, [], rules, 'RUNTIME')).toMatchObject({ outcome: 'MANUAL_REVIEW', primaryReasonCode: 'AGENT_TOOL_RESULTS_MISSING', appliedRuleId: 'CTRL-002', governanceControlApplied: true });
  });

  it('an explicit terminal business rule takes precedence over the generic incomplete-check control', () => {
    const decision = determineDecision(caseRecord, [row('DOCUMENT_EXTRACTION', 'PASS'), row('BUSINESS_VALIDATION', 'FAIL', ['REG-003'])], rules, 'RUNTIME');
    expect(decision).toMatchObject({ outcome: 'REJECT', primaryReasonCode: 'BUSINESS_INACTIVE', appliedRuleId: 'REG-003', governanceControlApplied: false });
    expect(decision.checksNotRun).toEqual(['IDENTITY_VALIDATION', 'AUTHORITY_VALIDATION', 'SYSTEM_DATA_CHECK', 'FINANCIAL_CHECK', 'FINAL_VERIFICATION']);
  });

  it('applies confirmed rules in source priority order (lowest Priority number wins)', () => {
    const rows = [row('DOCUMENT_EXTRACTION', 'FAIL', ['DOC-002']), row('IDENTITY_VALIDATION', 'INCONCLUSIVE', ['ID-002'])];
    expect(determineDecision(caseRecord, rows, rules, 'RUNTIME')).toMatchObject({ appliedRuleId: 'DOC-002', outcome: 'NEED_MORE_INFORMATION' });
    expect(determineDecision(caseRecord, [...rows].reverse(), rules, 'RUNTIME').appliedRuleId).toBe('DOC-002');
  });

  it('a TBD rule can never produce an automated approval or rejection: CTRL-001 TBD_POLICY, even alongside a terminal REJECT rule', () => {
    const rows = [...allPass.slice(0, 5), row('FINANCIAL_CHECK', 'INCONCLUSIVE', ['FIN-002']), row('FINAL_VERIFICATION', 'FAIL', ['CMP-002'])];
    const decision = determineDecision(caseRecord, rows, rules, 'RUNTIME');
    expect(decision).toMatchObject({ outcome: 'MANUAL_REVIEW', primaryReasonCode: 'TBD_POLICY', appliedRuleId: 'CTRL-001', triggeringTbdRule: 'FIN-002', governanceControlApplied: true, targetQueue: 'POLICY_REVIEW' });
  });

  it('throws "Approval blocked" (source behaviour) when a check is present but neither passing nor governed by a terminal rule', () => {
    const rows = allPass.map((entry) => entry.checkType === 'IDENTITY_VALIDATION' ? row('IDENTITY_VALIDATION', 'INCONCLUSIVE') : entry);
    expect(() => determineDecision(caseRecord, rows, rules, 'RUNTIME')).toThrow('Approval blocked. Mandatory checks incomplete: IDENTITY_VALIDATION');
  });

  it('UNRESOLVED_SOURCE_GAP results are routed conservatively to CTRL-003, never to the throw path', () => {
    const rows = [row('DOCUMENT_EXTRACTION', 'INCONCLUSIVE', [], { findings: { sourceGap: true }, reasonCodes: ['UNRESOLVED_SOURCE_GAP'] })];
    const decision = determineDecision(caseRecord, rows, rules, 'RUNTIME');
    expect(decision).toMatchObject({ outcome: 'MANUAL_REVIEW', appliedRuleId: 'CTRL-003' });
    expect(decision.secondaryReasonCodes).toContain('UNRESOLVED_SOURCE_GAP');
  });

  it('normalises casing and whitespace of statuses and check types', () => {
    const rows = mandatoryCheckTypes.map((checkType) => row(` ${checkType.toLowerCase()} `, ' pass '));
    expect(determineDecision(caseRecord, rows, rules, 'RUNTIME').outcome).toBe('APPROVE');
  });

  it('MOCK source with no rows is not CTRL-002 (source only applies it to RUNTIME) and blocks approval', () => {
    expect(() => determineDecision(caseRecord, [], rules, 'MOCK')).toThrow(/Approval blocked/);
  });

  it('derives missing information, conflicts and customer-safe summary exactly as the source', () => {
    const rows = [row('DOCUMENT_EXTRACTION', 'FAIL', ['AUTH-002'], { findings: { missing: ['AUTHORITY_LETTER'] } }), row('SYSTEM_DATA_CHECK', 'INCONCLUSIVE', ['CRM-002'], { findings: { legal_name_conflict: true, open_duplicate_request: true, scope: 'ambiguous', security_flag: 'PROMPT_INJECTION_TEST_STRING', lookup_status: 'unavailable' } })];
    const decision = determineDecision(caseRecord, rows, rules, 'RUNTIME');
    expect(decision.missingInformation).toEqual(['AUTHORITY_LETTER']);
    expect(decision.conflicts).toEqual(['Conflicting legal names exist across CRM records.', 'Another authority request is already open.', 'The submitted authority scope is ambiguous.', 'A document security flag requires specialist review.', 'The business-register lookup is unavailable.']);
    expect(decision.customerSafeSummary).toBe('The assessment cannot be completed until the requested information is supplied.');
  });

  it('is deterministic and contains no model dependency', () => {
    expect(determineDecision(caseRecord, allPass, rules, 'RUNTIME', '2026-01-01T00:00:00.000Z')).toEqual(determineDecision(caseRecord, allPass, rules, 'RUNTIME', '2026-01-01T00:00:00.000Z'));
    const sourceText = readFileSync('packages/governance/src/index.ts', 'utf8');
    expect(sourceText).not.toMatch(/agent-runtime|anthropic|claude|openai/i);
  });

  it('parses the result source like "Prepare Result Source" (default MOCK, unsupported rejected)', () => {
    expect(parseResultSource(undefined)).toBe('MOCK');
    expect(parseResultSource(' runtime ')).toBe('RUNTIME');
    expect(() => parseResultSource('CACHE')).toThrow('Unsupported result source: CACHE. Use MOCK or RUNTIME.');
  });
});

describe('finalizeDecision persistence', () => {
  it('finalising from MOCK fixtures reproduces the source AUTH results', async () => {
    const repo = newStore();
    expect((await finalizeDecision(repo, 'AUTH-001', 1, 'MOCK')).decision).toMatchObject({ outcome: 'APPROVE', resultSource: 'MOCK' });
    expect((await finalizeDecision(repo, 'AUTH-004', 1, 'MOCK')).decision).toMatchObject({ outcome: 'REJECT', primaryReasonCode: 'BUSINESS_INACTIVE' });
  });

  it('with no persisted runtime results the RUNTIME finalizer yields CTRL-002 and still drafts a communication', async () => {
    const repo = newStore();
    const { decision, communication } = await finalizeDecision(repo, 'AUTH-001', 1, 'RUNTIME');
    expect(decision.primaryReasonCode).toBe('AGENT_TOOL_RESULTS_MISSING');
    expect(communication).toMatchObject({ templateId: 'TPL-MANUAL-REVIEW', status: 'DRAFT', sent: false });
    expect((await repo.getRuntimeCase('AUTH-001'))?.status).toBe('REVIEW_PENDING');
  });

  it('writes decision, communication, runtime case and audit atomically (rolls back on failure)', async () => {
    class FailingRepository extends InMemoryRepository { public override async appendAudit(): Promise<void> { throw new Error('audit store unavailable'); } }
    const base = newStore();
    const failing = new FailingRepository((base as unknown as { source: never }).source);
    await expect(finalizeDecision(failing, 'AUTH-001', 1, 'MOCK')).rejects.toThrow('audit store unavailable');
    expect(await failing.getDecision('AUTH-001')).toBeUndefined();
    expect(await failing.getCommunications('AUTH-001')).toEqual([]);
    expect(await failing.getRuntimeCase('AUTH-001')).toBeUndefined();
  });

  it('emits decision, communication and state-change audit events', async () => {
    const repo = newStore();
    await finalizeDecision(repo, 'AUTH-001', 1, 'MOCK');
    expect((await repo.getAudit('AUTH-001')).map((event) => event.eventType).sort()).toEqual(['CASE_STATE_CHANGED', 'COMMUNICATION_DRAFTED', 'DECISION_GENERATED']);
  });

  it('is idempotent: finalising twice keeps one decision and one initial communication', async () => {
    const repo = newStore();
    await finalizeDecision(repo, 'AUTH-001', 1, 'MOCK');
    await finalizeDecision(repo, 'AUTH-001', 1, 'MOCK');
    expect((await repo.getCommunications('AUTH-001')).map((communication) => communication.communicationId)).toEqual(['COMM-AUTH-001-V1-INITIAL']);
    expect((await repo.getDecision('AUTH-001'))?.decisionId).toBe('DEC-AUTH-001-1');
  });
});

describe('communication templates', () => {
  it('fills the exact source placeholders and leaves unknown placeholders untouched', () => {
    expect(fillTemplate('{case_id} / {missing_items} / {unknown}', { case_id: 'AUTH-002', missing_items: 'AUTHORITY_LETTER' })).toBe('AUTH-002 / AUTHORITY_LETTER / {unknown}');
  });

  it.each([
    ['AUTH-002', 'TPL-NMI', 'Additional information required for request AUTH-002', 'AUTHORITY_LETTER'],
    ['AUTH-001', 'TPL-APPROVE', 'Your authorised representative request AUTH-001 is ready to proceed', ''],
    ['AUTH-004', 'TPL-REJECT', 'Update on authorised representative request AUTH-004', ''],
    ['AUTH-005', 'TPL-MANUAL-REVIEW', 'Request AUTH-005 requires additional review', ''],
  ])('%s renders %s as a DRAFT with no unresolved placeholders and no internal-only fields', async (caseRunId, templateId, subject, mustContain) => {
    const repo = newStore();
    const { evaluateCase } = await import('@sbo/workflows');
    const { ScriptedRuntime } = await import('@sbo/testkit');
    const result = await evaluateCase(repo, new ScriptedRuntime(), caseRunId);
    expect(result.communication).toMatchObject({ templateId, subject, status: 'DRAFT', approvalRequired: true, sent: false });
    expect(result.communication.body).not.toMatch(/\{\w+\}/);
    if (mustContain) expect(result.communication.body).toContain(mustContain);
    const template = (await repo.getTemplate(templateId))!;
    const rendered = renderCommunication((await repo.getCase(caseRunId))!, result.decision, template);
    expect(rendered.body).not.toMatch(/risk score|threshold|credit hold|prompt|chain-of-thought|Rule_|CTRL-|SEC-00/i);
  });
});
