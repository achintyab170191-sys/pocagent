import { describe, expect, it } from 'vitest';
import { classifyContinuation, evaluateCase, handleChatMessage, normaliseEvidenceMethod, resolveCaseRequest, resolveEvidenceAndContinue, submitTextEvidence, submitUploadedEvidence, completeHumanReview, createResubmission, cancelEvidenceRequest, uploadUrlFor } from '@sbo/workflows';
import { completeAuth003Downstream, contradictory, insufficient, newStore, newStoreWith, resolved, ScriptedRuntime } from '@sbo/testkit';

const base = 'http://localhost:5173';
const chat = (store: ReturnType<typeof newStore>, runtime: ScriptedRuntime, sessionId: string, message: string) => handleChatMessage({ repository: store, agentRuntime: runtime, appBaseUrl: base }, { sessionId, message });
const authorityText = 'The signed authority letter grants account management, service ordering, plan changes and contract approval.';

describe('Resolve Case Request', () => {
  it.each([
    ['Evaluate AUTH-001', 'AUTH-001', 1], ['please check auth-003 now', 'AUTH-003', 1], ['Evaluate AUTH-008-V2', 'AUTH-008-V2', 2], ['AUTH-008-V1', 'AUTH-008-V1', 1],
  ])('%s → %s (v%i)', (text, caseRunId, version) => {
    expect(resolveCaseRequest(text, 's')).toMatchObject({ caseIdFound: true, caseRunId, submissionVersion: version });
  });
  it('reports when no case id is present', () => { expect(resolveCaseRequest('hello there')).toMatchObject({ caseIdFound: false, caseRunId: '', submissionVersion: null }); });
  it('normalises evidence-method replies like the source', () => {
    expect(['upload', 'FILE', ' Document ', 'pdf'].map(normaliseEvidenceMethod)).toEqual(['FILE_UPLOAD', 'FILE_UPLOAD', 'FILE_UPLOAD', 'FILE_UPLOAD']);
    expect(['text', 'CHAT', 'paste', 'Type'].map(normaliseEvidenceMethod)).toEqual(['CHAT_TEXT', 'CHAT_TEXT', 'CHAT_TEXT', 'CHAT_TEXT']);
    expect(['maybe', ''].map(normaliseEvidenceMethod)).toEqual(['', '']);
  });
  it('classifies continuation exactly as the source table', () => {
    const c = (primaryReasonCode: string, outcome = 'MANUAL_REVIEW', missingInformation: string[] = []) => classifyContinuation({ outcome: outcome as never, primaryReasonCode, missingInformation });
    expect(c('DOCUMENT_MISSING', 'NEED_MORE_INFORMATION', ['AUTHORITY_LETTER'])).toMatchObject({ remediable: true, channel: 'FILE_UPLOAD', checkType: 'DOCUMENT_EXTRACTION', requestedItems: ['AUTHORITY_LETTER'] });
    expect(c('AUTHORITY_SCOPE_AMBIGUOUS')).toMatchObject({ remediable: true, channel: 'CHAT_OR_FILE' });
    expect(c('ADDITIONAL_DETAILS_REQUIRED')).toMatchObject({ remediable: true, channel: 'CHAT_TEXT', checkType: 'REQUEST_CLARIFICATION' });
    for (const reason of ['REGISTRY_UNAVAILABLE', 'DUPLICATE_RECORD_CONFLICT', 'PROMPT_INJECTION_DETECTED', 'TBD_POLICY', 'BUSINESS_INACTIVE']) expect(c(reason)).toMatchObject({ remediable: false, channel: 'HUMAN_REVIEW', requestedItems: [] });
    expect(c('SOMETHING_NEW', 'NEED_MORE_INFORMATION', ['x'])).toMatchObject({ remediable: true, channel: 'CHAT_TEXT', checkType: 'REQUEST_CLARIFICATION', requestedItems: ['x'] });
    expect(c('SOMETHING_NEW', 'REJECT')).toMatchObject({ remediable: false, channel: 'NONE' });
  });
});

describe('agentic chat', () => {
  it('rejects messages without a case id and unknown cases without running an assessment', async () => {
    const store = newStore();
    expect((await chat(store, new ScriptedRuntime(), 's', 'hello')).messages).toEqual(['I could not find a supported synthetic Case Run ID. Enter a case such as AUTH-001, AUTH-003, or AUTH-008-V2.']);
    const missing = await chat(store, new ScriptedRuntime(), 's', 'Evaluate AUTH-999');
    expect(missing.messages).toEqual(['Synthetic case AUTH-999 was not found. No assessment was performed.']);
    expect(await store.getRuntimeResults('AUTH-999', 1)).toEqual([]);
  });

  it('AUTH-001 returns a curated business response: outcome, validation path, next step, disclaimer — and nothing internal', async () => {
    const reply = await chat(newStore(), new ScriptedRuntime(), 'sess-1', 'Evaluate AUTH-001');
    expect(reply).toMatchObject({ sessionId: 'sess-1', step: 'DONE', caseRunId: 'AUTH-001', syntheticDataDisclaimer: true, outcome: { governedOutcome: 'APPROVE', primaryReasonCode: 'ALL_CHECKS_PASSED', provisionalOutcome: 'APPROVE', governanceOverride: false } });
    const text = reply.messages.join('\n');
    expect(text).toContain('## ✅ Eligible to proceed');
    expect(text).toContain('**Business:**');
    expect(text).toContain('All mandatory checks completed successfully.');
    expect(text).toContain('- ✓ Document checks — Passed');
    expect(text).toContain('- ✓ Final verification — Passed');
    expect(text).toContain('*Synthetic prototype. No production-system update or customer communication has been performed.*');
    expect(text).not.toMatch(/CTRL-|FINAL-001|findings|rule_ids|systemMessage|IGNORE|"status"|prototype_data|chain-of-thought/i);
  });

  it.each([
    ['AUTH-005', '## 👤 Specialist review required', 'Conflicting customer or party records require reconciliation.', '### Operational route\nCustomer Data Reconciliation'],
    ['AUTH-004', '## ⛔ Unable to proceed', 'The business-registration status does not support automated progression.', ''],
    ['AUTH-010', '## 👤 Specialist review required', 'The case requires review by the relevant policy owner.', '### Operational route\nPolicy Review'],
    ['AUTH-009', '## 👤 Specialist review required', 'A submitted document requires specialist security review.', '### Operational route\nSecurity Review'],
  ])('%s is explained in customer-safe language', async (caseRunId, heading, why, route) => {
    const reply = await chat(newStore(), new ScriptedRuntime(), 's', `Evaluate ${caseRunId}`);
    const text = reply.messages.join('\n');
    expect(text).toContain(heading);
    expect(text).toContain(why);
    if (route) expect(text).toContain(route);
    expect(reply.evidenceRequest).toBeUndefined();
    expect(text).not.toMatch(/SEC-001|REG-003|CRM-002|PROMPT_INJECTION_TEST_STRING|security_flag/);
  });

  it('AUTH-002 (file evidence) goes straight to the upload prompt with the secure form link', async () => {
    const reply = await chat(newStore(), new ScriptedRuntime(), 's', 'Evaluate AUTH-002');
    expect(reply.step).toBe('AWAITING_UPLOAD');
    expect(reply.evidenceRequest).toMatchObject({ evidenceChannel: 'FILE_UPLOAD', status: 'OPEN', requestedItems: ['Authority letter or approved delegation evidence'] });
    const text = reply.messages.join('\n');
    expect(text).toContain('Additional documentary evidence is required to continue case AUTH-002.');
    expect(text).toContain(`${base}/upload?evidence_request_id=${encodeURIComponent(reply.evidenceRequest!.evidenceRequestId)}&case_run_id=AUTH-002`);
    expect(text).toContain('reply UPLOADED');
    expect(reply.evidenceRequest!.uploadUrl).toBe(uploadUrlFor(base, { evidenceRequestId: reply.evidenceRequest!.evidenceRequestId, caseRunId: 'AUTH-002' }));
  });

  it('AUTH-003: asks TEXT or UPLOAD, accepts TEXT, resolves the evidence and resumes (EVID-001 path)', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([resolved]);
    const first = await chat(store, runtime, 'sess', 'Evaluate AUTH-003');
    expect(first.step).toBe('AWAITING_METHOD');
    expect(first.messages[0]).toContain('Reply TEXT to enter the clarification directly in this chat.');
    const second = await chat(store, runtime, 'sess', 'text');
    expect(second.step).toBe('AWAITING_TEXT');
    expect(second.messages[0]).toContain('Type CANCEL to stop this evidence request.');
    const third = await chat(store, runtime, 'sess', authorityText);
    expect(third.messages[0]).toBe('Thank you. The additional evidence has resolved the identified gap.\n\nI will now continue from the next incomplete validation check.');
    expect(third.outcome).toMatchObject({ governedOutcome: 'MANUAL_REVIEW', primaryReasonCode: 'MANDATORY_CHECKS_INCOMPLETE', toolsCalled: ['System Data Check'] });
    expect(third.step).toBe('DONE');
    expect((await store.getEvidenceRequest(first.evidenceRequest!.evidenceRequestId))?.status).toBe('ACCEPTED');
    expect(JSON.stringify(third)).not.toContain(authorityText);
  });

  it('AUTH-003 with a complete downstream fixture ends in a curated APPROVE after the evidence loop', async () => {
    const store = newStoreWith(completeAuth003Downstream);
    const runtime = new ScriptedRuntime([resolved]);
    await chat(store, runtime, 'sess', 'Evaluate AUTH-003');
    await chat(store, runtime, 'sess', 'TEXT');
    const done = await chat(store, runtime, 'sess', authorityText);
    expect(done.messages.join('\n')).toContain('## ✅ Eligible to proceed');
    expect(done.messages.join('\n')).toContain('- ✓ Authority validation — Passed');
  });

  it('method selection: one retry prompt, then a failure message that leaves the case WAITING_FOR_EVIDENCE', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    const first = await chat(store, runtime, 's', 'Evaluate AUTH-003');
    const retry = await chat(store, runtime, 's', 'whatever');
    expect(retry.step).toBe('AWAITING_METHOD');
    expect(retry.messages[0]).toContain('I could not identify the evidence method from your response.');
    const failed = await chat(store, runtime, 's', 'still no idea');
    expect(failed.step).toBe('IDLE');
    expect(failed.messages[0]).toContain('The case will remain in WAITING_FOR_EVIDENCE status.');
    expect((await store.getRuntimeCase('AUTH-003'))?.status).toBe('WAITING_FOR_EVIDENCE');
    expect((await store.getEvidenceRequest(first.evidenceRequest!.evidenceRequestId))?.status).toBe('OPEN');
  });

  it('TEXT path: empty input asks again; CANCEL cancels the request and the case', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    const first = await chat(store, runtime, 's', 'Evaluate AUTH-003');
    await chat(store, runtime, 's', 'TEXT');
    const empty = await chat(store, runtime, 's', '   ');
    expect(empty.messages[0]).toContain('I did not receive any evidence text.');
    expect(empty.step).toBe('AWAITING_TEXT');
    const cancelled = await chat(store, runtime, 's', 'cancel');
    expect(cancelled.messages[0]).toBe('The additional-evidence request has been cancelled.\n\nThe case remains unresolved and no further automated processing has been performed.');
    expect(cancelled.step).toBe('DONE');
    expect((await store.getEvidenceRequest(first.evidenceRequest!.evidenceRequestId))?.status).toBe('CANCELLED');
    expect((await store.getRuntimeCase('AUTH-003'))?.status).toBe('EVIDENCE_REQUEST_CANCELLED');
    expect(runtime.resolutionRequests).toHaveLength(0);
  });

  it('UPLOAD path: "UPLOADED" without a stored upload re-prompts; after the upload the chat resolves it', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([resolved]);
    const first = await chat(store, runtime, 's', 'Evaluate AUTH-003');
    const requestId = first.evidenceRequest!.evidenceRequestId;
    const upload = await chat(store, runtime, 's', 'UPLOAD');
    expect(upload.step).toBe('AWAITING_UPLOAD');
    const missing = await chat(store, runtime, 's', 'UPLOADED');
    expect(missing.messages[0]).toContain(`I could not find an uploaded evidence record for request ${requestId}.`);
    expect(runtime.resolutionRequests).toHaveLength(0);
    await submitUploadedEvidence(store, requestId, { fileName: 'authority.pdf', mimeType: 'application/pdf', storageUrl: 'x', extractedText: authorityText });
    const resolvedReply = await chat(store, runtime, 's', 'UPLOADED');
    expect(resolvedReply.messages[0]).toContain('Thank you. The additional evidence has resolved the identified gap.');
    expect(runtime.resolutionRequests).toHaveLength(1);
  });

  it('UPLOAD path: CANCEL cancels the request', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    const first = await chat(store, runtime, 's', 'Evaluate AUTH-002');
    const cancelled = await chat(store, runtime, 's', 'STOP');
    expect(cancelled.messages[0]).toBe('The evidence-upload request has been cancelled.\n\nThe case remains unresolved, and no further automated processing has been performed.');
    expect((await store.getEvidenceRequest(first.evidenceRequest!.evidenceRequestId))?.status).toBe('CANCELLED');
  });

  it('insufficient evidence explains the remaining gap and re-asks; the third attempt escalates to a human evidence reviewer', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([insufficient, insufficient, insufficient]);
    await chat(store, runtime, 's', 'Evaluate AUTH-003');
    await chat(store, runtime, 's', 'TEXT');
    const one = await chat(store, runtime, 's', 'First partial clarification of authority.');
    expect(one.step).toBe('AWAITING_METHOD');
    expect(one.messages[0]).toBe('The evidence does not yet resolve the identified gap.\n\nRemaining requirements:\n• Signed authority wording is still missing.\n\nPlease provide a revised clarification or document.');
    await chat(store, runtime, 's', 'TEXT');
    const two = await chat(store, runtime, 's', 'Second partial clarification of authority.');
    expect(two.step).toBe('AWAITING_METHOD');
    await chat(store, runtime, 's', 'TEXT');
    const three = await chat(store, runtime, 's', 'Third partial clarification of authority.');
    expect(three).toMatchObject({ step: 'DONE', messages: ['The available evidence remains insufficient after the allowed number of attempts.\n\nThe case has been routed to a human evidence reviewer. No final adverse decision has been made.'] });
    expect((await store.getReview('REV-AUTH-003-EVIDENCE-1'))?.reviewStatus).toBe('PENDING');
  });

  it('contradictory evidence routes to a human evidence reviewer with the source message', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([contradictory]);
    await chat(store, runtime, 's', 'Evaluate AUTH-003');
    await chat(store, runtime, 's', 'TEXT');
    const reply = await chat(store, runtime, 's', 'The named representative left the company last year.');
    expect(reply.messages[0]).toBe('The new evidence conflicts with previously validated case information.\n\nThe case has been routed to a human evidence reviewer. No automated reconciliation or final adverse decision has been made.');
    expect((await store.getReview('REV-AUTH-003-EVIDENCE-1'))).toMatchObject({ agentRecommendation: 'MANUAL_REVIEW' });
  });

  it('conversation state is per session', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    await chat(store, runtime, 'a', 'Evaluate AUTH-003');
    const other = await chat(store, runtime, 'b', 'TEXT');
    expect(other.messages).toEqual(['I could not find a supported synthetic Case Run ID. Enter a case such as AUTH-001, AUTH-003, or AUTH-008-V2.']);
    expect((await store.getSession('a'))?.step).toBe('AWAITING_METHOD');
  });

  it('re-evaluating a case in chat resets its runtime results (source entry path) rather than resuming', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    await chat(store, runtime, 's', 'Evaluate AUTH-001');
    const again = await chat(store, runtime, 's', 'Evaluate AUTH-001');
    expect(again.outcome?.toolsCalled).toHaveLength(7);
  });
});

describe('audit completeness across a full journey', () => {
  it('records every material transition with source event names where the source has one', async () => {
    const store = newStoreWith(completeAuth003Downstream);
    const runtime = new ScriptedRuntime([insufficient, resolved]);
    const initial = await evaluateCase(store, runtime, 'AUTH-003', 's');
    const id = initial.evidenceRequest!.evidenceRequestId;
    await submitTextEvidence(store, id, { text: 'A partial clarification of the authority.' });
    await resolveEvidenceAndContinue(store, runtime, id, 'AUTH-003', 1, 's');
    await submitTextEvidence(store, id, { text: authorityText });
    await resolveEvidenceAndContinue(store, runtime, id, 'AUTH-003', 1, 's');
    const types = (await store.getAudit('AUTH-003')).map((event) => event.eventType);
    for (const expected of ['ASSESSMENT_STARTED', 'UTILITY_CHECK_COMPLETED', 'DECISION_GENERATED', 'COMMUNICATION_DRAFTED', 'CASE_STATE_CHANGED', 'EVIDENCE_REQUESTED', 'ADDITIONAL_EVIDENCE_RECEIVED', 'ADDITIONAL_EVIDENCE_REQUIRED', 'ASSESSMENT_RESUMED']) expect(types, expected).toContain(expected);
    // ordering of the key milestones
    const first = (type: string) => types.indexOf(type);
    expect(first('ASSESSMENT_STARTED')).toBeLessThan(first('UTILITY_CHECK_COMPLETED'));
    expect(first('UTILITY_CHECK_COMPLETED')).toBeLessThan(first('DECISION_GENERATED'));
    expect(first('DECISION_GENERATED')).toBeLessThan(first('EVIDENCE_REQUESTED'));
    expect(first('EVIDENCE_REQUESTED')).toBeLessThan(first('ADDITIONAL_EVIDENCE_RECEIVED'));
    expect(first('ADDITIONAL_EVIDENCE_RECEIVED')).toBeLessThan(first('ADDITIONAL_EVIDENCE_REQUIRED'));
    expect(first('ASSESSMENT_RESUMED')).toBeGreaterThan(first('ADDITIONAL_EVIDENCE_REQUIRED'));
    expect(types.filter((type) => type === 'ADDITIONAL_EVIDENCE_RECEIVED')).toHaveLength(2);
    expect(types.filter((type) => type === 'ADDITIONAL_EVIDENCE_REQUIRED')).toHaveLength(2);
  });

  it('every audit event has a unique id, the case run id, a version, an actor, a timestamp and no secrets', async () => {
    const store = newStore();
    await evaluateCase(store, new ScriptedRuntime(), 'AUTH-005', 's');
    const events = await store.getAudit('AUTH-005');
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
    for (const event of events) {
      expect(event).toMatchObject({ caseRunId: 'AUTH-005', submissionVersion: 1 });
      expect(event.actor).toBeTruthy();
      expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
      expect(JSON.stringify(event)).not.toMatch(/sk-ant|password|api[_-]?key/i);
    }
  });

  it('review, resubmission and cancellation transitions are audited', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    const review = (await evaluateCase(store, runtime, 'AUTH-010', 's')).review!;
    await completeHumanReview(store, review.reviewId, { reviewerName: 'R', reviewerDecision: 'APPROVE', reviewerComments: 'ok' });
    await evaluateCase(store, runtime, 'AUTH-008-V1', 's');
    await createResubmission(store, { originalCaseRunId: 'AUTH-008-V1', revisedCaseRunId: 'AUTH-008-V2', resubmissionComments: 'c' }, runtime);
    const evidence = (await evaluateCase(store, runtime, 'AUTH-002', 's')).evidenceRequest!;
    await cancelEvidenceRequest(store, evidence.evidenceRequestId);
    expect((await store.getAudit('AUTH-010')).map((event) => event.eventType)).toEqual(expect.arrayContaining(['REVIEW_CREATED', 'HUMAN_REVIEW_COMPLETED']));
    expect((await store.getAudit('AUTH-008-V1')).map((event) => event.eventType)).toContain('CASE_RESUBMITTED');
    expect((await store.getAudit('AUTH-002')).map((event) => event.eventType)).toContain('EVIDENCE_REQUEST_CANCELLED');
  });

  it('rapid same-millisecond writes never collide (IDs are strictly unique)', async () => {
    const store = newStore();
    const initial = await evaluateCase(store, new ScriptedRuntime(), 'AUTH-003', 's');
    const a = await submitTextEvidence(store, initial.evidenceRequest!.evidenceRequestId, { text: 'first clarification about authority' });
    await store.persistEvidenceRequest({ ...initial.evidenceRequest!, status: 'INSUFFICIENT' });
    const b = await submitTextEvidence(store, initial.evidenceRequest!.evidenceRequestId, { text: 'second clarification about authority' });
    expect(a.evidenceId).not.toBe(b.evidenceId);
    expect(await store.getEvidence(initial.evidenceRequest!.evidenceRequestId)).toHaveLength(2);
  });
});
