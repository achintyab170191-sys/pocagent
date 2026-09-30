import { describe, expect, it } from 'vitest';
import { type HumanReview } from '@sbo/domain';
import { completeHumanReview, createResubmission, evaluateCase, getCaseStatus, getReviewPackage, resolveEvidenceAndContinue, submitTextEvidence } from '@sbo/workflows';
import { insufficient, newStore, ScriptedRuntime } from '@sbo/testkit';

async function openReview(caseRunId = 'AUTH-005') {
  const store = newStore();
  const result = await evaluateCase(store, new ScriptedRuntime(), caseRunId, 's');
  return { store, result, review: result.review! };
}
const input = (overrides: Record<string, string> = {}) => ({ reviewerName: 'Riley Reviewer', reviewerDecision: 'NEED_MORE_INFORMATION' as const, reviewerComments: 'Please supply the reconciled CRM account name.', overrideReason: '', ...overrides });

describe('Workflow 91 — human review portal (source version: APPROVE / NEED_MORE_INFORMATION / REJECT)', () => {
  it('creates a PENDING review for a non-remediable MANUAL_REVIEW and exposes case + decision context', async () => {
    const { store, review } = await openReview('AUTH-005');
    expect(review).toMatchObject({ reviewId: 'REV-AUTH-005-1', reviewStatus: 'PENDING', reviewQueue: 'DATA_RECONCILIATION', agentRecommendation: 'MANUAL_REVIEW' });
    const pack = await getReviewPackage(store, review.reviewId);
    expect(pack).toMatchObject({ caseRunId: 'AUTH-005', originalOutcome: 'MANUAL_REVIEW', originalPrimaryReasonCode: 'DUPLICATE_RECORD_CONFLICT', originalDecisionId: 'DEC-AUTH-005-1', prototypeData: true });
    expect(pack.businessName).toBeTruthy();
    expect(pack.originalConflicts.length).toBeGreaterThan(0);
    expect((await store.getAudit('AUTH-005')).map((event) => event.eventType)).toContain('REVIEW_CREATED');
  });

  it('completes an open review exactly as source: review COMPLETED, decision updated in place, HUMAN communication draft, case updated, audited', async () => {
    const { store, review } = await openReview('AUTH-005');
    const before = (await store.getDecision('AUTH-005'))!;
    const done = await completeHumanReview(store, review.reviewId, input());
    expect(done.review).toMatchObject({ reviewStatus: 'COMPLETED', reviewerName: 'Riley Reviewer', reviewerDecision: 'NEED_MORE_INFORMATION', reviewerComments: 'Please supply the reconciled CRM account name.' });
    expect(done.review.completedAt).toBeTruthy();
    const decision = (await store.getDecision('AUTH-005'))!;
    expect(decision).toMatchObject({ decisionId: before.decisionId, outcome: 'NEED_MORE_INFORMATION', primaryReasonCode: 'DUPLICATE_RECORD_CONFLICT', targetQueue: 'CUSTOMER_FOLLOW_UP', communicationTemplateId: 'TPL-NMI', humanReviewRequired: false, createdAt: before.createdAt });
    expect(decision.secondaryReasonCodes).toContain('HUMAN_REVIEW_COMPLETED');
    expect(decision.internalSummary).toBe('Human review completed by Riley Reviewer. Comments: Please supply the reconciled CRM account name.');
    const communications = await store.getCommunications('AUTH-005');
    const human = communications.find((communication) => communication.communicationId === 'COMM-AUTH-005-V1-HUMAN')!;
    expect(human).toMatchObject({ templateId: 'TPL-NMI', status: 'DRAFT', sent: false });
    expect(human.body).toContain('Please supply the reconciled CRM account name.');
    expect(communications.map((communication) => communication.communicationId)).toContain('COMM-AUTH-005-V1-INITIAL');
    expect(await store.getRuntimeCase('AUTH-005')).toMatchObject({ status: 'WAITING_FOR_INFORMATION', currentStage: 'HUMAN_REVIEW_COMPLETE', finalOutcome: 'NEED_MORE_INFORMATION', targetQueue: 'CUSTOMER_FOLLOW_UP', humanReviewRequired: false });
    expect((await store.getAudit('AUTH-005')).find((event) => event.eventType === 'HUMAN_REVIEW_COMPLETED')).toMatchObject({ actor: 'Riley Reviewer', stage: 'HUMAN_REVIEW', previousState: 'MANUAL_REVIEW', newState: 'NEED_MORE_INFORMATION', reasonCode: 'DUPLICATE_RECORD_CONFLICT', evidenceReference: 'Review ID: REV-AUTH-005-1' });
  });

  it.each([
    ['APPROVE', 'ORDER_READINESS', 'READY_TO_PROCEED', 'TPL-APPROVE'],
    ['NEED_MORE_INFORMATION', 'CUSTOMER_FOLLOW_UP', 'WAITING_FOR_INFORMATION', 'TPL-NMI'],
    ['REJECT', 'CASE_CLOSURE', 'REJECTED_CONFIRMED', 'TPL-REJECT'],
  ] as const)('reviewer decision %s maps to queue %s, case status %s, template %s', async (decision, queue, status, template) => {
    const { store, review } = await openReview('AUTH-010');
    const done = await completeHumanReview(store, review.reviewId, input({ reviewerDecision: decision }));
    expect(done.decision).toMatchObject({ outcome: decision, targetQueue: queue, communicationTemplateId: template });
    expect((await store.getRuntimeCase('AUTH-010'))?.status).toBe(status);
  });

  it('prevents duplicate completion: a completed review cannot be submitted again and nothing changes', async () => {
    const { store, review } = await openReview();
    await completeHumanReview(store, review.reviewId, input());
    const snapshot = { decision: await store.getDecision('AUTH-005'), audit: (await store.getAudit('AUTH-005')).length, communications: (await store.getCommunications('AUTH-005')).length };
    await expect(completeHumanReview(store, review.reviewId, input({ reviewerName: 'Second Person', reviewerDecision: 'APPROVE' }))).rejects.toThrow('REVIEW_ALREADY_COMPLETED');
    await expect(getReviewPackage(store, review.reviewId)).rejects.toThrow('REVIEW_ALREADY_COMPLETED');
    expect(await store.getDecision('AUTH-005')).toEqual(snapshot.decision);
    expect((await store.getAudit('AUTH-005')).length).toBe(snapshot.audit);
    expect((await store.getCommunications('AUTH-005')).length).toBe(snapshot.communications);
    expect((await store.getReview(review.reviewId))?.reviewerName).toBe('Riley Reviewer');
  });

  it('two simultaneous submissions complete the review exactly once', async () => {
    const { store, review } = await openReview();
    const results = await Promise.allSettled([completeHumanReview(store, review.reviewId, input({ reviewerName: 'A' })), completeHumanReview(store, review.reviewId, input({ reviewerName: 'B', reviewerDecision: 'APPROVE' }))]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    expect((await store.getAudit('AUTH-005')).filter((event) => event.eventType === 'HUMAN_REVIEW_COMPLETED')).toHaveLength(1);
  });

  it('a review that is not found is reported without side effects', async () => {
    const store = newStore();
    await expect(getReviewPackage(store, 'REV-NOPE')).rejects.toThrow('REVIEW_NOT_FOUND');
    await expect(completeHumanReview(store, 'REV-NOPE', input())).rejects.toThrow('REVIEW_NOT_FOUND');
  });

  it('validates the reviewer submission like the source', async () => {
    const { store, review } = await openReview();
    await expect(completeHumanReview(store, review.reviewId, input({ reviewerName: '  ' }))).rejects.toThrow('REVIEWER_NAME_REQUIRED');
    await expect(completeHumanReview(store, review.reviewId, input({ reviewerComments: '' }))).rejects.toThrow('REVIEWER_COMMENTS_REQUIRED');
    await expect(completeHumanReview(store, review.reviewId, input({ reviewerDecision: 'RESOLVED_PASS' }))).rejects.toThrow('UNSUPPORTED_REVIEWER_DECISION:RESOLVED_PASS');
    expect((await store.getReview(review.reviewId))?.reviewStatus).toBe('PENDING');
  });

  it('changing a REJECT recommendation requires an override reason; confirming REJECT does not', async () => {
    const { store, review } = await openReview('AUTH-004');
    expect(review).toMatchObject({ agentRecommendation: 'REJECT', reviewStatus: 'PENDING_REJECTION_CONFIRMATION' });
    await expect(completeHumanReview(store, review.reviewId, input({ reviewerDecision: 'APPROVE' }))).rejects.toThrow('OVERRIDE_REASON_REQUIRED');
    const done = await completeHumanReview(store, review.reviewId, input({ reviewerDecision: 'APPROVE', overrideReason: 'Register was stale; verified active manually.' }));
    expect(done.review.overrideReason).toBe('Register was stale; verified active manually.');
    const other = await openReview('AUTH-006');
    expect((await completeHumanReview(other.store, other.review.reviewId, input({ reviewerDecision: 'REJECT' }))).decision.outcome).toBe('REJECT');
  });

  it('an evidence-escalation review (created by Workflow 03) can be completed with the same portal', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([insufficient, insufficient, insufficient]);
    const initial = await evaluateCase(store, runtime, 'AUTH-003', 's');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await submitTextEvidence(store, initial.evidenceRequest!.evidenceRequestId, { text: `Clarification attempt number ${attempt} for the authority.` });
      await resolveEvidenceAndContinue(store, runtime, initial.evidenceRequest!.evidenceRequestId, 'AUTH-003', 1);
    }
    const pack = await getReviewPackage(store, 'REV-AUTH-003-EVIDENCE-1');
    expect(pack).toMatchObject({ reviewQueue: 'EVIDENCE_REVIEW', agentRecommendation: 'NEED_MORE_INFORMATION' });
    const done = await completeHumanReview(store, 'REV-AUTH-003-EVIDENCE-1', input());
    expect(done.review.reviewStatus).toBe('COMPLETED');
  });

  it('the source review-status vocabulary is preserved for pre-seeded rows', async () => {
    const store = newStore();
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-005', 's');
    const seeded: HumanReview = { reviewId: 'REV-CUSTOM-1', caseRunId: 'AUTH-005', reviewQueue: 'DATA_RECONCILIATION', agentRecommendation: 'MANUAL_REVIEW', reviewerName: '', reviewerDecision: '', reviewerComments: '', overrideReason: '', reviewStatus: 'pending_rejection_confirmation', requestedAt: new Date().toISOString(), completedAt: '' };
    await store.persistReview(seeded);
    expect((await getReviewPackage(store, 'REV-CUSTOM-1')).reviewId).toBe('REV-CUSTOM-1');
  });
});

describe('Workflow 92 — versioned resubmission (AUTH-008-V1 → AUTH-008-V2)', () => {
  it('assesses the revised version, supersedes the original and records lineage', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    const v1 = await evaluateCase(store, runtime, 'AUTH-008-V1', 's');
    expect(v1.decision).toMatchObject({ outcome: 'NEED_MORE_INFORMATION', primaryReasonCode: 'AUTHORITY_SCOPE_INSUFFICIENT', submissionVersion: 1, caseId: 'AUTH-008' });
    const v2 = await createResubmission(store, { originalCaseRunId: 'AUTH-008-V1', revisedCaseRunId: 'AUTH-008-V2', resubmissionComments: 'Updated authority letter attached.' }, runtime);
    expect(v2.decision).toMatchObject({ outcome: 'APPROVE', primaryReasonCode: 'ALL_CHECKS_PASSED', submissionVersion: 2, caseRunId: 'AUTH-008-V2', caseId: 'AUTH-008', decisionId: 'DEC-AUTH-008-V2-2' });
    // both versions are separate case runs of one logical case, each with its own decision and runtime rows
    expect((await store.getDecision('AUTH-008-V1'))?.outcome).toBe('NEED_MORE_INFORMATION');
    expect((await store.getRuntimeResults('AUTH-008-V1', 1)).length).toBe(4);
    expect((await store.getRuntimeResults('AUTH-008-V2', 2)).length).toBe(7);
    expect(await store.getRuntimeCase('AUTH-008-V1')).toMatchObject({ status: 'SUPERSEDED_BY_RESUBMISSION', currentStage: 'RESUBMITTED', targetQueue: 'AUTH-008-V2', humanReviewRequired: false, submissionVersion: 1 });
    expect(await store.getRuntimeCase('AUTH-008-V2')).toMatchObject({ status: 'READY_TO_PROCEED', finalOutcome: 'APPROVE', submissionVersion: 2, caseId: 'AUTH-008' });
    const audit = (await store.getAudit('AUTH-008-V1')).find((event) => event.eventType === 'CASE_RESUBMITTED')!;
    expect(audit).toMatchObject({ actor: 'CUSTOMER_SYNTHETIC', stage: 'RESUBMISSION', previousState: 'WAITING_FOR_INFORMATION', newState: 'RESUBMITTED', reasonCode: 'REVISED_EVIDENCE_SUBMITTED', evidenceReference: 'AUTH-008-V2', submissionVersion: 1 });
    expect(audit.details).toMatchObject({ original_version: 1, revised_version: 2, revised_outcome: 'APPROVE', comments: 'Updated authority letter attached.' });
  });

  it('is distinct from same-case evidence continuation: no new case run is created by evidence', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([insufficient]);
    const initial = await evaluateCase(store, runtime, 'AUTH-008-V1', 's');
    await submitTextEvidence(store, initial.evidenceRequest!.evidenceRequestId, { text: 'Additional authority clarification for the request.' });
    await resolveEvidenceAndContinue(store, runtime, initial.evidenceRequest!.evidenceRequestId, 'AUTH-008-V1', 1);
    expect(await store.getRuntimeCase('AUTH-008-V2')).toBeUndefined();
    expect((await store.getRuntimeCase('AUTH-008-V1'))?.status).not.toBe('SUPERSEDED_BY_RESUBMISSION');
  });

  it.each([
    ['AUTH-001', 'AUTH-008-V2', 'RESUBMISSION_NOT_ALLOWED'],
    ['AUTH-008-V1', 'AUTH-001', 'INVALID_REVISED_VERSION'],
    ['AUTH-008-V1', 'AUTH-008-V1', 'INVALID_REVISED_VERSION'],
    ['AUTH-008-V1', 'AUTH-999', 'RESUBMISSION_CASE_NOT_FOUND'],
  ])('rejects %s → %s with %s and changes nothing', async (original, revised, code) => {
    const store = newStore();
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-001', 's');
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-008-V1', 's');
    const before = (await store.getAudit('AUTH-008-V1')).length;
    await expect(createResubmission(store, { originalCaseRunId: original, revisedCaseRunId: revised, resubmissionComments: 'c' }, new ScriptedRuntime())).rejects.toThrow(code);
    expect((await store.getAudit('AUTH-008-V1')).length).toBe(before);
    expect(await store.getRuntimeCase('AUTH-008-V2')).toBeUndefined();
  });

  it('requires the original decision to exist and blocks a second resubmission of the same original', async () => {
    const store = newStore();
    await expect(createResubmission(store, { originalCaseRunId: 'AUTH-008-V1', revisedCaseRunId: 'AUTH-008-V2', resubmissionComments: 'c' }, new ScriptedRuntime())).rejects.toThrow('RESUBMISSION_NOT_ALLOWED');
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-008-V1', 's');
    await createResubmission(store, { originalCaseRunId: 'AUTH-008-V1', revisedCaseRunId: 'AUTH-008-V2', resubmissionComments: 'c' }, new ScriptedRuntime());
    await expect(createResubmission(store, { originalCaseRunId: 'AUTH-008-V1', revisedCaseRunId: 'AUTH-008-V2', resubmissionComments: 'again' }, new ScriptedRuntime())).rejects.toThrow('RESUBMISSION_ALREADY_CREATED');
  });
});

describe('case status view (Workflow 93 adapter)', () => {
  it('reports INITIAL for an unassessed case with a synthetic-data warning', async () => {
    const view = await getCaseStatus(newStore(), 'AUTH-001');
    expect(view).toMatchObject({ currentStatus: 'INITIAL', currentStage: 'INITIAL', outcome: '', humanReview: null, latestEvidenceRequest: null, latestEvidence: null, latestCommunication: null, syntheticDataDisclaimer: true, caseIdentifiers: { caseRunId: 'AUTH-001', caseId: 'AUTH-001', submissionVersion: 1 } });
    expect(view.dataQualityWarnings.join(' ')).toContain('synthetic');
    expect(view.dataQualityWarnings.join(' ')).toContain('not been assessed');
  });

  it('renders identifiers, status, stage, outcome, reason, summary, next action, queue and latest communication', async () => {
    const store = newStore();
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-001', 's');
    const view = await getCaseStatus(store, 'AUTH-001');
    expect(view).toMatchObject({ currentStatus: 'READY_TO_PROCEED', currentStage: 'DECISION_COMPLETE', outcome: 'APPROVE', primaryReason: 'ALL_CHECKS_PASSED', targetQueue: 'ORDER_READINESS' });
    expect(view.summary).toBe('The prototype assessment completed all mandatory checks successfully. The request is eligible to proceed to the next operational step.');
    expect(view.nextAction).toContain('do not perform production write-back');
    expect(view.latestCommunication).toMatchObject({ templateId: 'TPL-APPROVE', status: 'DRAFT' });
  });

  it('shows the latest evidence request, evidence record and human-review state through the evidence journey', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([insufficient]);
    const initial = await evaluateCase(store, runtime, 'AUTH-003', 's');
    let view = await getCaseStatus(store, 'AUTH-003');
    expect(view).toMatchObject({ currentStatus: 'WAITING_FOR_EVIDENCE', latestEvidenceRequest: { evidenceRequestId: initial.evidenceRequest!.evidenceRequestId, status: 'OPEN', evidenceChannel: 'CHAT_OR_FILE', attemptCount: 0, maxAttempts: 3 }, latestEvidence: null });
    await submitTextEvidence(store, initial.evidenceRequest!.evidenceRequestId, { text: 'A short clarification of the requested authority.' });
    await resolveEvidenceAndContinue(store, runtime, initial.evidenceRequest!.evidenceRequestId, 'AUTH-003', 1);
    view = await getCaseStatus(store, 'AUTH-003');
    expect(view.latestEvidenceRequest).toMatchObject({ status: 'INSUFFICIENT', attemptCount: 1 });
    expect(view.latestEvidence).toMatchObject({ evidenceSource: 'CHAT_TEXT', validationStatus: 'INSUFFICIENT' });
    expect(JSON.stringify(view)).not.toContain('evidenceText');
  });

  it('shows the human-review state for review cases and the superseded state after resubmission', async () => {
    const store = newStore();
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-010', 's');
    expect((await getCaseStatus(store, 'AUTH-010')).humanReview).toEqual({ reviewId: 'REV-AUTH-010-1', status: 'PENDING', queue: 'POLICY_REVIEW' });
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-008-V1', 's');
    await createResubmission(store, { originalCaseRunId: 'AUTH-008-V1', revisedCaseRunId: 'AUTH-008-V2', resubmissionComments: 'c' }, new ScriptedRuntime());
    expect(await getCaseStatus(store, 'AUTH-008-V1')).toMatchObject({ currentStatus: 'SUPERSEDED_BY_RESUBMISSION', currentStage: 'RESUBMITTED', targetQueue: 'AUTH-008-V2' });
    expect(await getCaseStatus(store, 'AUTH-008-V2')).toMatchObject({ currentStatus: 'READY_TO_PROCEED', outcome: 'APPROVE', caseIdentifiers: { caseId: 'AUTH-008', submissionVersion: 2 } });
  });

  it('warns when more than one evidence request is active and reports unknown cases as not found', async () => {
    const store = newStore();
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-003', 's');
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-003', 's');
    expect((await getCaseStatus(store, 'AUTH-003')).dataQualityWarnings.join(' ')).toContain('More than one evidence request');
    await expect(getCaseStatus(store, 'AUTH-404')).rejects.toThrow('CASE_NOT_FOUND');
  });

  it('never exposes raw prompts, tool JSON, rule rows or internal summaries', async () => {
    const store = newStore();
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-005', 's');
    const text = JSON.stringify(await getCaseStatus(store, 'AUTH-005'));
    expect(text).not.toMatch(/internalSummary|findings|CRM-002|rule_ids|systemMessage|legal_name_conflict|Applied /);
  });
});
