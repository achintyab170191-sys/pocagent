import { describe, expect, it } from 'vitest';
import { classifyContinuation, evaluateCase, handleChatMessage, handleChatEvidenceUpload, resolveCaseRequest, resolveEvidenceAndContinue, submitTextEvidence, completeHumanReview, createResubmission, cancelEvidenceRequest } from '@sbo/workflows';
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
  it('greets a new customer by asking for their name and company instead of a case id, and runs no assessment', async () => {
    const store = newStore();
    const hello = await chat(store, new ScriptedRuntime(), 's', 'hello');
    expect(hello).toMatchObject({ step: 'IDLE', caseRunId: '' });
    expect(hello.messages[0]).toContain('your name');
    expect(hello.messages[0]).toContain('the company you represent');
    expect(hello.outcome).toBeUndefined();
  });

  it('unknown case ids are not assessed', async () => {
    const store = newStore();
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

  it('AUTH-002 (file evidence) asks for documents in the same chat: no link, no method question, no "UPLOADED" instruction', async () => {
    const reply = await chat(newStore(), new ScriptedRuntime(), 's', 'Evaluate AUTH-002');
    expect(reply.step).toBe('AWAITING_EVIDENCE');
    expect(reply.evidenceRequest).toMatchObject({ evidenceChannel: 'FILE_UPLOAD', status: 'OPEN', requestedItems: ['Authority letter or approved delegation evidence'] });
    const text = reply.messages.join('\n');
    expect(text).toContain('Please provide the following additional evidence:');
    expect(text).toContain('attach documents (PDF, Word or image files)');
    expect(text).not.toMatch(/\/upload|reply UPLOADED|Reply TEXT|UPLOAD or TEXT/i);
  });

  it('AUTH-003: the customer just types the answer — no TEXT/UPLOAD question — and the evidence loop resumes (EVID-001 path)', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([resolved]);
    const first = await chat(store, runtime, 'sess', 'Evaluate AUTH-003');
    expect(first.step).toBe('AWAITING_EVIDENCE');
    expect(first.messages.join('\n')).not.toMatch(/Reply TEXT|reply UPLOADED/i);
    const second = await chat(store, runtime, 'sess', authorityText);
    expect(second.messages[0]).toBe('Thank you. The additional evidence has resolved the identified gap.\n\nI will now continue from the next incomplete validation check.');
    expect(second.outcome).toMatchObject({ governedOutcome: 'MANUAL_REVIEW', primaryReasonCode: 'MANDATORY_CHECKS_INCOMPLETE', toolsCalled: ['System Data Check'] });
    expect(second.step).toBe('DONE');
    expect((await store.getEvidenceRequest(first.evidenceRequest!.evidenceRequestId))?.status).toBe('ACCEPTED');
    expect(JSON.stringify(second)).not.toContain(authorityText);
  });

  it('AUTH-003 with a complete downstream fixture ends in a curated APPROVE after the evidence loop', async () => {
    const store = newStoreWith(completeAuth003Downstream);
    const runtime = new ScriptedRuntime([resolved]);
    await chat(store, runtime, 'sess', 'Evaluate AUTH-003');
    const done = await chat(store, runtime, 'sess', authorityText);
    expect(done.messages.join('\n')).toContain('## ✅ Eligible to proceed');
    expect(done.messages.join('\n')).toContain('- ✓ Authority validation — Passed');
  });

  it('attached documents (text already extracted) are the evidence: stored, assessed, then the case resumes', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([resolved]);
    const first = await chat(store, runtime, 's', 'Evaluate AUTH-002');
    const requestId = first.evidenceRequest!.evidenceRequestId;
    const reply = await handleChatEvidenceUpload({ repository: store, agentRuntime: runtime, appBaseUrl: base }, { sessionId: 's', files: [
      { fileName: 'authority.pdf', mimeType: 'application/pdf', storageUrl: 'a', extractedText: authorityText },
      { fileName: 'scan.png', mimeType: 'image/png', storageUrl: 'b', extractedText: 'Signed by the director, valid for account management.' },
    ] });
    expect(reply.messages[0]).toContain('Thank you. The additional evidence has resolved the identified gap.');
    expect(runtime.resolutionRequests).toHaveLength(1);
    expect((await store.getEvidence(requestId)).map((row) => row.fileName)).toEqual(expect.arrayContaining(['authority.pdf', 'scan.png']));
    expect((await store.getEvidenceRequest(requestId))?.status).toBe('ACCEPTED');
  });

  it('attaching a file with no pending evidence request is refused', async () => {
    await expect(handleChatEvidenceUpload({ repository: newStore(), agentRuntime: new ScriptedRuntime(), appBaseUrl: base }, { sessionId: 'none', files: [{ fileName: 'a.pdf', mimeType: 'application/pdf', storageUrl: 'x', extractedText: authorityText }] })).rejects.toThrow('NO_EVIDENCE_REQUEST_PENDING');
  });

  it('CANCEL (typed or by button) cancels the evidence request and the case; nothing is assessed', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    const first = await chat(store, runtime, 's', 'Evaluate AUTH-003');
    const empty = await chat(store, runtime, 's', '   ');
    expect(empty.messages[0]).toContain('I did not receive anything.');
    expect(empty.step).toBe('AWAITING_EVIDENCE');
    const cancelled = await chat(store, runtime, 's', 'cancel');
    expect(cancelled.messages[0]).toBe('The additional-evidence request has been cancelled.\n\nThe case remains unresolved and no further automated processing has been performed.');
    expect(cancelled.step).toBe('DONE');
    expect((await store.getEvidenceRequest(first.evidenceRequest!.evidenceRequestId))?.status).toBe('CANCELLED');
    expect((await store.getRuntimeCase('AUTH-003'))?.status).toBe('EVIDENCE_REQUEST_CANCELLED');
    expect(runtime.resolutionRequests).toHaveLength(0);
  });

  it('insufficient evidence explains the gap and the same prompt returns; re-upload is always possible; the third attempt escalates', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([insufficient, insufficient, insufficient]);
    await chat(store, runtime, 's', 'Evaluate AUTH-003');
    const one = await chat(store, runtime, 's', 'First partial clarification of authority.');
    expect(one.step).toBe('AWAITING_EVIDENCE');
    expect(one.messages[0]).toBe('The evidence does not yet resolve the identified gap.\n\nRemaining requirements:\n• Signed authority wording is still missing.\n\nPlease provide a revised clarification or document.');
    expect(one.messages[1]).toContain('attach documents');
    const two = await handleChatEvidenceUpload({ repository: store, agentRuntime: runtime, appBaseUrl: base }, { sessionId: 's', files: [{ fileName: 'again.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', storageUrl: 'x', extractedText: 'Second partial clarification of authority.' }] });
    expect(two.step).toBe('AWAITING_EVIDENCE');
    const three = await chat(store, runtime, 's', 'Third partial clarification of authority.');
    expect(three).toMatchObject({ step: 'DONE', messages: ['The available evidence remains insufficient after the allowed number of attempts.\n\nThe case has been routed to a human evidence reviewer. No final adverse decision has been made.'] });
    expect((await store.getReview('REV-AUTH-003-EVIDENCE-1'))?.reviewStatus).toBe('PENDING');
  });

  it('contradictory evidence routes to a human evidence reviewer with the source message', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([contradictory]);
    await chat(store, runtime, 's', 'Evaluate AUTH-003');
    const reply = await chat(store, runtime, 's', 'The named representative left the company last year.');
    expect(reply.messages[0]).toBe('The new evidence conflicts with previously validated case information.\n\nThe case has been routed to a human evidence reviewer. No automated reconciliation or final adverse decision has been made.');
    expect((await store.getReview('REV-AUTH-003-EVIDENCE-1'))).toMatchObject({ agentRecommendation: 'MANUAL_REVIEW' });
  });

  it('conversation state is per session', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    await chat(store, runtime, 'a', 'Evaluate AUTH-003');
    const other = await chat(store, runtime, 'b', 'some clarification');
    expect(other.step).toBe('IDLE');
    expect(other.messages[0]).toContain('your name');
    expect((await store.getSession('a'))?.step).toBe('AWAITING_EVIDENCE');
  });

  it('a new customer introduces themselves; a case is opened and assessed against the matched scenario', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    const reply = await chat(store, runtime, 'new', 'Hi, my name is Liam Chen and I represent Bluegum Vector Demo Pty Ltd.');
    expect(reply.caseRunId).toMatch(/^AUTH-1\d\d$/);
    expect(reply.messages[0]).toContain(`opened case **${reply.caseRunId}**`);
    expect(reply.step).toBe('AWAITING_EVIDENCE');
    expect(await store.getCase(reply.caseRunId)).toMatchObject({ representativeName: 'Liam Chen', businessName: 'Bluegum Vector Demo Pty Ltd' });
  });

  it('intake asks only for what is missing, over several turns', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    const one = await chat(store, runtime, 'i', 'My name is Liam Chen');
    expect(one).toMatchObject({ step: 'INTAKE', caseRunId: '' });
    expect(one.messages[0]).toContain('Which company');
    const two = await chat(store, runtime, 'i', 'Bluegum Vector Demo Pty Ltd');
    expect(two.caseRunId).toMatch(/^AUTH-1\d\d$/);
  });

  it('a brand-new customer gets a synthetic case of their own and the full assessment runs (no specialist shortcut)', async () => {
    const store = newStore();
    const reply = await chat(store, new ScriptedRuntime(), 'x', 'My name is Zed Nobody and I represent Acme Imaginary Holdings Ltd');
    expect(reply.step).toBe('DONE');
    expect(reply.outcome?.toolsCalled).toHaveLength(7);
    expect(reply.outcome).toMatchObject({ governedOutcome: 'APPROVE', humanReviewRequired: false });
    expect(reply.messages.join('\n')).toContain('you are a new customer');
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
