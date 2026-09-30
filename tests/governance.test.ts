import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '@sbo/persistence';
import { type CaseRecord, loaCommunicationTemplates, loaDecisionRules, mandatoryCheckTypes } from '@sbo/domain';
import { determineDecision, finalizeDecision, fillTemplate, parseResultSource, renderCommunication, type CheckRow } from '@sbo/governance';
import { evaluateCase, handleChatMessage, resolveEvidence, submitDocumentEvidence } from '@sbo/workflows';
import { newStore, persona, personaAttachments, ScriptedRuntime } from '@sbo/testkit';

const caseRecord: CaseRecord = { caseRunId: 'AUTH-101', caseId: 'AUTH-101', submissionVersion: 1, country: 'AE', requestType: 'NEW_LOA_PROCESSING', channel: 'CHAT_INTAKE', businessName: 'Al Noor Trading LLC', businessIdentifier: '', customerId: '', representativeName: 'Fatima Al Mansoori', representativeRole: '', requestedAuthority: 'x', requestNarrative: 'x', documentsSubmitted: '', submittedAt: '2026-01-01T00:00:00.000Z', processingPriority: 'STANDARD', syntheticOnly: true };
const passRule: Record<string, string> = { TRADE_LICENSE_CHECK: 'TL-000', IDENTITY_VALIDATION: 'ID-000', POA_MOA_CHECK: 'POA-000', BAD_DEBT_CHECK: 'BD-000', AVCV_VERIFICATION: 'AV-000' };
const row = (checkType: string, status = 'PASS', ruleIds?: string[], extra: Partial<CheckRow> = {}): CheckRow => ({ sequence: mandatoryCheckTypes.indexOf(checkType as never) + 1, agentId: 'SBO.06', utilityName: checkType, checkType, status, findings: {}, reasonCodes: [], ruleIds: ruleIds ?? [passRule[checkType] ?? ''], ...extra });
const allPass = (): CheckRow[] => mandatoryCheckTypes.map((checkType) => row(checkType));
const decide = (rows: CheckRow[], rules = loaDecisionRules, source: 'MOCK' | 'RUNTIME' = 'RUNTIME') => determineDecision(caseRecord, rows, rules, source);

describe('deterministic finalizer', () => {
  it('approves only when every mandatory check passes (FINAL-001)', () => {
    expect(decide(allPass())).toMatchObject({ outcome: 'APPROVE', appliedRuleId: 'FINAL-001', primaryReasonCode: 'ALL_CHECKS_PASSED', humanReviewRequired: false, targetQueue: 'ORDER_READINESS', communicationTemplateId: 'COMM-APPROVE', decisionId: 'DEC-AUTH-101-1' });
  });
  it('there are exactly five mandatory checks, in the governed order', () => {
    expect([...mandatoryCheckTypes]).toEqual(['TRADE_LICENSE_CHECK', 'IDENTITY_VALIDATION', 'POA_MOA_CHECK', 'BAD_DEBT_CHECK', 'AVCV_VERIFICATION']);
  });
  it('treats PASS_WITH_FLAG as passing and preserves the flag in completed checks', () => {
    const rows = allPass(); rows[0] = row('TRADE_LICENSE_CHECK', 'PASS_WITH_FLAG');
    const decision = decide(rows);
    expect(decision.outcome).toBe('APPROVE');
    expect(decision.completedChecks[0]).toMatchObject({ checkType: 'TRADE_LICENSE_CHECK', status: 'PASS_WITH_FLAG' });
  });
  it('never approves with fewer than five passes: one missing check → CTRL-003 MANDATORY_CHECKS_INCOMPLETE', () => {
    const decision = decide(allPass().slice(0, 4));
    expect(decision).toMatchObject({ outcome: 'MANUAL_REVIEW', appliedRuleId: 'CTRL-003', primaryReasonCode: 'MANDATORY_CHECKS_INCOMPLETE', governanceControlApplied: true, checksNotRun: ['AVCV_VERIFICATION'] });
  });
  it('treats NOT_RUN rows as absent', () => {
    const rows = allPass(); rows[4] = row('AVCV_VERIFICATION', 'NOT_RUN', []);
    expect(decide(rows)).toMatchObject({ appliedRuleId: 'CTRL-003', checksNotRun: ['AVCV_VERIFICATION'] });
  });
  it('zero persisted runtime results → CTRL-002 AGENT_TOOL_RESULTS_MISSING', () => {
    expect(decide([])).toMatchObject({ outcome: 'MANUAL_REVIEW', appliedRuleId: 'CTRL-002', primaryReasonCode: 'AGENT_TOOL_RESULTS_MISSING' });
  });
  it('an explicit terminal business rule takes precedence over the generic incomplete-check control', () => {
    expect(decide([row('TRADE_LICENSE_CHECK', 'FAIL', ['TL-002'])])).toMatchObject({ outcome: 'REJECT', appliedRuleId: 'TL-002', primaryReasonCode: 'TRADE_LICENSE_EXPIRED', humanReviewRequired: true, targetQueue: 'REJECTION_REVIEW', communicationTemplateId: 'COMM-REJECT' });
  });
  it('applies confirmed rules in priority order (lowest Priority number wins)', () => {
    expect(decide([row('TRADE_LICENSE_CHECK', 'FAIL', ['TL-002', 'TL-001'])])).toMatchObject({ appliedRuleId: 'TL-001', outcome: 'NEED_MORE_INFORMATION' });
  });
  it('a TBD rule can never produce an automated approval or rejection: CTRL-001 TBD_POLICY, even alongside a terminal REJECT rule', () => {
    const rules = loaDecisionRules.map((rule) => (rule.ruleId === 'BD-001' ? { ...rule, ruleStatus: 'TBD' } : rule));
    const rows = [...allPass().slice(0, 3), row('BAD_DEBT_CHECK', 'FAIL', ['BD-001'])];
    expect(decide(rows, rules)).toMatchObject({ outcome: 'MANUAL_REVIEW', appliedRuleId: 'CTRL-001', primaryReasonCode: 'TBD_POLICY', triggeringTbdRule: 'BD-001', governanceControlApplied: true });
  });
  it('throws "Approval blocked" when a check is present but neither passing nor governed by a terminal rule', () => {
    const rows = allPass(); rows[2] = row('POA_MOA_CHECK', 'INCONCLUSIVE', ['POA-000']);
    expect(() => decide(rows, loaDecisionRules, 'MOCK')).toThrow(/Approval blocked/);
  });
  it('a result with no basis (source gap) is routed conservatively to CTRL-003, never to the throw path', () => {
    const rows = allPass(); rows[1] = row('IDENTITY_VALIDATION', 'INCONCLUSIVE', [], { findings: { sourceGap: true } });
    expect(decide(rows)).toMatchObject({ appliedRuleId: 'CTRL-003' });
  });
  it('normalises casing and whitespace of statuses and check types', () => {
    const rows = allPass().map((entry) => ({ ...entry, checkType: ` ${entry.checkType.toLowerCase()} `, status: ' pass ' }));
    expect(decide(rows).outcome).toBe('APPROVE');
  });
  it('derives missing information, conflicts and a customer-safe summary from the findings', () => {
    const rows = [row('TRADE_LICENSE_CHECK'), row('IDENTITY_VALIDATION'), row('POA_MOA_CHECK', 'INCONCLUSIVE', ['POA-001'], { findings: { missing: ['POA_MOA'], conflicts: [] } })];
    const missing = decide(rows);
    expect(missing).toMatchObject({ outcome: 'NEED_MORE_INFORMATION', primaryReasonCode: 'POA_MOA_MISSING', missingInformation: ['POA_MOA'], customerSafeSummary: 'The assessment cannot be completed until the requested information is supplied.' });
    const rejected = decide([row('BAD_DEBT_CHECK', 'FAIL', ['BD-001'], { findings: { conflicts: ['Outstanding bad debt exists on an account linked to this business or person.'] } })]);
    expect(rejected.conflicts).toEqual(['Outstanding bad debt exists on an account linked to this business or person.']);
    expect(rejected.customerSafeSummary).toContain('Human confirmation is required');
  });
  it('is deterministic and contains no model dependency', () => {
    expect(decide(allPass(), loaDecisionRules, 'RUNTIME')).toEqual({ ...decide(allPass()), createdAt: expect.any(String) });
    const source = readFileSync('packages/governance/src/index.ts', 'utf8');
    expect(source).not.toMatch(/agent-runtime|anthropic|claude/i);
  });
  it('parses the result source (default MOCK, unsupported rejected)', () => {
    expect(parseResultSource(undefined)).toBe('MOCK');
    expect(parseResultSource(' runtime ')).toBe('RUNTIME');
    expect(() => parseResultSource('LIVE')).toThrow('Unsupported result source');
  });
});

describe('every rule points at a real template and a valid outcome', () => {
  it('references only existing communication templates and known outcomes', () => {
    const templates = new Set(loaCommunicationTemplates.map((template) => template.templateId));
    for (const rule of loaDecisionRules) {
      expect(templates.has(rule.communicationTemplateId), rule.ruleId).toBe(true);
      expect(['CONTINUE', 'APPROVE', 'REJECT', 'NEED_MORE_INFORMATION', 'MANUAL_REVIEW']).toContain(rule.finalOutcome);
      expect(rule.ruleStatus, rule.ruleId).not.toBe('TBD');
    }
    expect(new Set(loaDecisionRules.map((rule) => rule.ruleId)).size).toBe(loaDecisionRules.length);
  });
});

describe('finalizeDecision persistence', () => {
  async function readyCase(slug: string, store: InMemoryRepository = newStore()) {
    const opened = await handleChatMessage({ repository: store, agentRuntime: new ScriptedRuntime(), appBaseUrl: 'x' }, { sessionId: 's', message: `My name is ${persona(slug).representativeName} and I represent ${persona(slug).businessName}` });
    for (const file of personaAttachments(slug, ['EMIRATES_ID', 'TRADE_LICENSE', 'ESTABLISHMENT_CARD'])) await submitDocumentEvidence(store, opened.evidenceRequest!.evidenceRequestId, { fileName: file.fileName, mimeType: file.mimeType, storageUrl: 'x', extractedText: file.extractedText, allowReceived: true });
    await resolveEvidence(store, opened.evidenceRequest!.evidenceRequestId, opened.caseRunId, 1);
    return { store, caseRunId: opened.caseRunId };
  }

  it('with no persisted runtime results the RUNTIME finalizer yields CTRL-002 and still drafts a communication', async () => {
    const { store, caseRunId } = await readyCase('fatima-al-noor');
    const { decision, communication } = await finalizeDecision(store, caseRunId, 1, 'RUNTIME');
    expect(decision).toMatchObject({ appliedRuleId: 'CTRL-002', outcome: 'MANUAL_REVIEW' });
    expect(communication).toMatchObject({ communicationId: `COMM-${caseRunId}-V1-INITIAL`, templateId: 'COMM-REVIEW', status: 'DRAFT', sent: false });
  });

  it('writes decision, communication, runtime case and audit atomically (rolls back on failure)', async () => {
    class FlakyRepository extends InMemoryRepository { public failAudit = false; public override async appendAudit(event: Parameters<InMemoryRepository['appendAudit']>[0]): Promise<void> { if (this.failAudit) throw new Error('audit store down'); return super.appendAudit(event); } }
    const flaky = new FlakyRepository();
    const { caseRunId } = await readyCase('fatima-al-noor', flaky);
    flaky.failAudit = true;
    await expect(finalizeDecision(flaky, caseRunId, 1, 'RUNTIME')).rejects.toThrow('audit store down');
    flaky.failAudit = false;
    expect(await flaky.getDecision(caseRunId)).toBeUndefined();
    expect(await flaky.getCommunications(caseRunId)).toEqual([]);
  });
  it('emits decision, communication and state-change audit events, and is idempotent', async () => {
    const { store, caseRunId } = await readyCase('fatima-al-noor');
    await evaluateCase(store, new ScriptedRuntime(), caseRunId, 's');
    const before = (await store.getAudit(caseRunId)).map((event) => event.eventType);
    expect(before).toEqual(expect.arrayContaining(['DECISION_GENERATED', 'COMMUNICATION_DRAFTED', 'CASE_STATE_CHANGED', 'UTILITY_CHECK_COMPLETED']));
    await finalizeDecision(store, caseRunId, 1, 'RUNTIME');
    expect((await store.getCommunications(caseRunId))).toHaveLength(1);
    expect((await store.getDecision(caseRunId))?.outcome).toBe('APPROVE');
  });
});

describe('communication drafts (SBO.11)', () => {
  it('fills placeholders and leaves unknown placeholders untouched', () => {
    expect(fillTemplate('Hello {name}, {unknown}', { name: 'Ana' })).toBe('Hello Ana, {unknown}');
  });
  it.each([
    ['APPROVE', 'COMM-APPROVE', 'approved to proceed'], ['NEED_MORE_INFORMATION', 'COMM-NEED-INFO', 'more information needed'], ['MANUAL_REVIEW', 'COMM-REVIEW', 'under specialist review'], ['REJECT', 'COMM-REJECT', 'unable to proceed'],
  ])('%s renders template %s as an unsent draft', (outcome, templateId, subject) => {
    const decision = decide(outcome === 'APPROVE' ? allPass() : outcome === 'REJECT' ? [row('TRADE_LICENSE_CHECK', 'FAIL', ['TL-002'])] : outcome === 'MANUAL_REVIEW' ? [] : [row('POA_MOA_CHECK', 'INCONCLUSIVE', ['POA-001'], { findings: { missing: ['POA_MOA'] } })]);
    const template = loaCommunicationTemplates.find((entry) => entry.templateId === templateId)!;
    const communication = renderCommunication(caseRecord, decision, template);
    expect(communication).toMatchObject({ templateId, status: 'DRAFT', approvalRequired: true, sent: false });
    expect(communication.subject).toContain(subject);
    expect(communication.body).toContain('has not been sent');
    expect(communication.body).not.toMatch(/\{\w+\}/);
  });
});
