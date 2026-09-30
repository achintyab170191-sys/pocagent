import { describe, expect, it } from 'vitest';
import { newStore, ScriptedRuntime } from '@sbo/testkit';
import { evaluateCase } from '@sbo/workflows';

const seven = ['Document Checks', 'Business Validation', 'Identity Validation', 'Authority Validation', 'System Data Check', 'Financial Check', 'Final Verification'];
const mandatory = ['DOCUMENT_EXTRACTION', 'BUSINESS_VALIDATION', 'IDENTITY_VALIDATION', 'AUTHORITY_VALIDATION', 'SYSTEM_DATA_CHECK', 'FINANCIAL_CHECK', 'FINAL_VERIFICATION'];

interface Expectation {
  caseRunId: string; outcome: string; reason: string; ruleId: string; tools: string[]; rowTypes: string[];
  status: string; stage: string; queue: string; template: string;
  evidenceChannel?: string; review?: { queue: string; status: string };
}

// Expected values are derived from dt_decision_rules / dt_mock_utility_results and cross-checked against the historical dt_cases_runtime export.
const expectations: Expectation[] = [
  { caseRunId: 'AUTH-001', outcome: 'APPROVE', reason: 'ALL_CHECKS_PASSED', ruleId: 'FINAL-001', tools: seven, rowTypes: mandatory, status: 'READY_TO_PROCEED', stage: 'DECISION_COMPLETE', queue: 'ORDER_READINESS', template: 'TPL-APPROVE' },
  { caseRunId: 'AUTH-002', outcome: 'NEED_MORE_INFORMATION', reason: 'AUTHORITY_MISSING', ruleId: 'AUTH-002', tools: seven.slice(0, 1), rowTypes: mandatory.slice(0, 1), status: 'WAITING_FOR_EVIDENCE', stage: 'CUSTOMER_EVIDENCE', queue: 'CUSTOMER_FOLLOW_UP', template: 'TPL-NMI', evidenceChannel: 'FILE_UPLOAD' },
  { caseRunId: 'AUTH-003', outcome: 'MANUAL_REVIEW', reason: 'AUTHORITY_SCOPE_AMBIGUOUS', ruleId: 'AUTH-004', tools: seven.slice(0, 4), rowTypes: mandatory.slice(0, 4), status: 'WAITING_FOR_EVIDENCE', stage: 'CUSTOMER_EVIDENCE', queue: 'CUSTOMER_FOLLOW_UP', template: 'TPL-MANUAL-REVIEW', evidenceChannel: 'CHAT_OR_FILE' },
  { caseRunId: 'AUTH-004', outcome: 'REJECT', reason: 'BUSINESS_INACTIVE', ruleId: 'REG-003', tools: seven.slice(0, 2), rowTypes: mandatory.slice(0, 2), status: 'REJECTION_CONFIRMATION_PENDING', stage: 'HUMAN_CONFIRMATION', queue: 'BUSINESS_VALIDATION_REVIEW', template: 'TPL-REJECT', review: { queue: 'BUSINESS_VALIDATION_REVIEW', status: 'PENDING_REJECTION_CONFIRMATION' } },
  { caseRunId: 'AUTH-005', outcome: 'MANUAL_REVIEW', reason: 'DUPLICATE_RECORD_CONFLICT', ruleId: 'CRM-002', tools: seven.slice(0, 5), rowTypes: mandatory.slice(0, 5), status: 'REVIEW_PENDING', stage: 'HUMAN_REVIEW', queue: 'DATA_RECONCILIATION', template: 'TPL-MANUAL-REVIEW', review: { queue: 'DATA_RECONCILIATION', status: 'PENDING' } },
  { caseRunId: 'AUTH-006', outcome: 'REJECT', reason: 'FINAL_VERIFICATION_FAILED', ruleId: 'CMP-002', tools: seven, rowTypes: mandatory, status: 'REJECTION_CONFIRMATION_PENDING', stage: 'HUMAN_CONFIRMATION', queue: 'COMPLIANCE_REVIEW', template: 'TPL-REJECT', review: { queue: 'COMPLIANCE_REVIEW', status: 'PENDING_REJECTION_CONFIRMATION' } },
  { caseRunId: 'AUTH-007', outcome: 'MANUAL_REVIEW', reason: 'REGISTRY_UNAVAILABLE', ruleId: 'REG-002', tools: seven.slice(0, 2), rowTypes: mandatory.slice(0, 2), status: 'REVIEW_PENDING', stage: 'HUMAN_REVIEW', queue: 'REGISTRY_VERIFICATION', template: 'TPL-MANUAL-REVIEW', review: { queue: 'REGISTRY_VERIFICATION', status: 'PENDING' } },
  { caseRunId: 'AUTH-008-V1', outcome: 'NEED_MORE_INFORMATION', reason: 'AUTHORITY_SCOPE_INSUFFICIENT', ruleId: 'AUTH-005', tools: seven.slice(0, 4), rowTypes: mandatory.slice(0, 4), status: 'WAITING_FOR_EVIDENCE', stage: 'CUSTOMER_EVIDENCE', queue: 'CUSTOMER_FOLLOW_UP', template: 'TPL-NMI', evidenceChannel: 'CHAT_OR_FILE' },
  { caseRunId: 'AUTH-008-V2', outcome: 'APPROVE', reason: 'ALL_CHECKS_PASSED', ruleId: 'FINAL-001', tools: seven, rowTypes: mandatory, status: 'READY_TO_PROCEED', stage: 'DECISION_COMPLETE', queue: 'ORDER_READINESS', template: 'TPL-APPROVE' },
  // Source detail: the fixture row is DOCUMENT_EXTRACTION_AND_SECURITY; Workflow 05's ILIKE lookup returns it and SEC-001 is terminal.
  { caseRunId: 'AUTH-009', outcome: 'MANUAL_REVIEW', reason: 'PROMPT_INJECTION_DETECTED', ruleId: 'SEC-001', tools: seven.slice(0, 1), rowTypes: ['DOCUMENT_EXTRACTION_AND_SECURITY'], status: 'REVIEW_PENDING', stage: 'HUMAN_REVIEW', queue: 'SECURITY_REVIEW', template: 'TPL-MANUAL-REVIEW', review: { queue: 'SECURITY_REVIEW', status: 'PENDING' } },
  { caseRunId: 'AUTH-010', outcome: 'MANUAL_REVIEW', reason: 'TBD_POLICY', ruleId: 'CTRL-001', tools: seven.slice(0, 6), rowTypes: mandatory.slice(0, 6), status: 'REVIEW_PENDING', stage: 'HUMAN_REVIEW', queue: 'POLICY_REVIEW', template: 'TPL-MANUAL-REVIEW', review: { queue: 'POLICY_REVIEW', status: 'PENDING' } },
];

describe('all AUTH source cases (parity regression)', () => {
  it.each(expectations)('$caseRunId → $outcome / $reason', async (expected) => {
    const store = newStore();
    const result = await evaluateCase(store, new ScriptedRuntime(), expected.caseRunId, 'session-1');
    const caseRecord = (await store.getCase(expected.caseRunId))!;

    // governed outcome, reason, rule and queue
    expect(result.decision.outcome).toBe(expected.outcome);
    expect(result.decision.primaryReasonCode).toBe(expected.reason);
    expect(result.decision.appliedRuleId).toBe(expected.ruleId);
    expect(result.decision.communicationTemplateId).toBe(expected.template);
    // exact tool sequence and early stopping
    expect(result.trace.map((step) => step.tool)).toEqual(expected.tools);
    // persisted runtime rows: one per check type, in sequence, nothing beyond the stop point
    const rows = await store.getRuntimeResults(expected.caseRunId, caseRecord.submissionVersion);
    expect(rows.map((row) => row.checkType)).toEqual(expected.rowTypes);
    expect(new Set(rows.map((row) => row.checkType)).size).toBe(rows.length);
    // decision, runtime case and draft communication persisted
    expect((await store.getDecision(expected.caseRunId))?.decisionId).toBe(`DEC-${expected.caseRunId}-${caseRecord.submissionVersion}`);
    const runtimeCase = (await store.getRuntimeCase(expected.caseRunId))!;
    expect(runtimeCase.status).toBe(expected.status);
    expect(runtimeCase.currentStage).toBe(expected.stage);
    expect(runtimeCase.targetQueue).toBe(expected.queue);
    const communications = await store.getCommunications(expected.caseRunId);
    expect(communications).toHaveLength(1);
    expect(communications[0]).toMatchObject({ communicationId: `COMM-${expected.caseRunId}-V${caseRecord.submissionVersion}-INITIAL`, templateId: expected.template, status: 'DRAFT', sent: false });
    // evidence request or human review, exactly as the source classification dictates
    if (expected.evidenceChannel) {
      expect(result.evidenceRequest?.evidenceChannel).toBe(expected.evidenceChannel);
      expect(result.evidenceRequest?.status).toBe('OPEN');
      expect(result.evidenceRequest?.maxAttempts).toBe(3);
      expect(result.review).toBeUndefined();
    } else {
      expect(result.evidenceRequest).toBeUndefined();
    }
    if (expected.review) {
      const reviews = await store.getReviews(expected.caseRunId);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ reviewQueue: expected.review.queue, reviewStatus: expected.review.status, agentRecommendation: expected.outcome });
    } else {
      expect(await store.getReviews(expected.caseRunId)).toHaveLength(0);
    }
    // deterministic governance agreed with the (deterministic) agent's provisional recommendation
    expect(result.governanceOverride).toBe(false);
    // one UTILITY_CHECK_COMPLETED audit event per tool call; runtime never marks production write-back
    const audit = await store.getAudit(expected.caseRunId);
    expect(audit.filter((event) => event.eventType === 'UTILITY_CHECK_COMPLETED')).toHaveLength(expected.tools.length);
    expect(result.decision.productionWritePerformed).toBe(false);
    expect(result.decision.prototypeData).toBe(true);
  });

  it('covers exactly the AUTH cases present in dt_synthetic_cases (no invented AUTH-011)', async () => {
    const ids = (await newStore().listCases()).map((entry) => entry.caseRunId).sort();
    expect(ids).toEqual(expectations.map((entry) => entry.caseRunId).sort());
    expect(ids).not.toContain('AUTH-011');
  });
});
