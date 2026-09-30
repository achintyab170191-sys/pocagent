/**
 * Conversation layer (Workflow 03's Agentic Chat + evidence loop) with a customer-first flow:
 *
 *   new customer → "my name is …, I represent …" → intake → case opened → checks run → curated result
 *                 → evidence needed? answer in the same window with TEXT and/or ATTACHED FILES (PDF / Word / image) — nothing to type but the answer
 *                 → insufficient? the same prompt returns and the customer simply adds more text or files
 *                 → needs a corrected version? "Submit corrected version" → versioned resubmission
 *
 * The source's TEXT/UPLOAD method question and the "UPLOADED" acknowledgement are intentionally removed (docs/07 G-31); every other
 * routing rule (resolve → resume / retry / escalate, cancel words, max attempts) is unchanged. `sendAndWait` pauses become persisted
 * ChatSessionState, so the API is stateless between requests.
 */
import { type AgentRuntime } from '@sbo/agent-runtime';
import { type ChatSessionState, type EvidenceRequest, type IntakeDetails } from '@sbo/domain';
import { type Repository, now } from '@sbo/persistence';
import { buildChatResponse } from './chat-response.js';
import { cancelEvidenceRequest, cancelWords, resolveEvidenceAndContinue, submitTextEvidence, submitUploadedEvidence, type EvidenceContinuation } from './evidence.js';
import { ensureRevisedCase, extractIntake, introMessage, looksLikeBareCompany, looksLikeBareName, nextVersionScenario, openIntakeCase } from './intake.js';
import { caseNotFoundMessage, evaluateCase, resolveCaseRequest, type AssessmentResult } from './super-agent.js';
import { createResubmission } from './resubmission.js';

export interface ChatReply {
  sessionId: string;
  step: ChatSessionState['step'];
  messages: string[];
  caseRunId: string;
  /** Curated outcome fields only — never raw prompts, tool JSON, rule rows, or chain-of-thought. */
  outcome?: { governedOutcome: string; primaryReasonCode: string; humanReviewRequired: boolean; provisionalOutcome: string; governanceOverride: boolean; toolsCalled: string[] };
  evidenceRequest?: { evidenceRequestId: string; evidenceChannel: string; requestedItems: string[]; status: string; attemptCount: number; maxAttempts: number };
  /** Buttons the client may offer (each simply sends a normal chat message, so nothing here is privileged). */
  actions?: { resubmit: boolean };
  syntheticDataDisclaimer: true;
}

export interface ChatDependencies { repository: Repository; agentRuntime: AgentRuntime; appBaseUrl: string; }
/** An already-stored, already-text-extracted attachment (extraction and storage happen in the API layer). */
export interface AttachedEvidence { fileName: string; mimeType: string; storageUrl: string; extractedText: string; }

const emptyIntake: IntakeDetails = { representativeName: '', businessName: '', businessIdentifier: '' };
const resubmitPattern = /\b(?:resubmit|re-submit|corrected version|revised version)\b/i;
const evidenceHint = 'You can type your answer below, attach documents (PDF, Word or image files), or both. To stop, choose "Cancel request".';
const cancelledMessage = 'The additional-evidence request has been cancelled.\n\nThe case remains unresolved and no further automated processing has been performed.';

function session(sessionId: string, caseRunId: string, step: ChatSessionState['step'], evidenceRequestId = '', intake: IntakeDetails = emptyIntake): ChatSessionState { return { sessionId, caseRunId, step, evidenceRequestId, intake, updatedAt: now() }; }

function outcomeView(result: AssessmentResult): NonNullable<ChatReply['outcome']> {
  return { governedOutcome: result.decision.outcome, primaryReasonCode: result.decision.primaryReasonCode, humanReviewRequired: result.decision.humanReviewRequired, provisionalOutcome: result.provisional.provisionalOutcome, governanceOverride: result.governanceOverride, toolsCalled: result.trace.map((step) => step.tool) };
}
function requestView(request: EvidenceRequest): NonNullable<ChatReply['evidenceRequest']> {
  return { evidenceRequestId: request.evidenceRequestId, evidenceChannel: request.evidenceChannel, requestedItems: request.requestedItems, status: request.status, attemptCount: request.attemptCount, maxAttempts: request.maxAttempts };
}
const evidencePrompt = (request: EvidenceRequest): string => `${request.customerMessage}\n\n${evidenceHint}`;

async function resubmitAvailable(repository: Repository, caseRunId: string, outcome: string): Promise<boolean> {
  if (outcome !== 'NEED_MORE_INFORMATION') return false;
  return Boolean(await nextVersionScenario(repository, caseRunId));
}

/** Present an assessment: an evidence prompt when the decision is customer-remediable, otherwise the curated response. */
async function presentAssessment(deps: ChatDependencies, sessionId: string, result: AssessmentResult, prefix: string[] = []): Promise<ChatReply> {
  const caseRecord = await deps.repository.getCase(result.decision.caseRunId);
  const outcome = outcomeView(result);
  const canResubmit = await resubmitAvailable(deps.repository, result.decision.caseRunId, result.decision.outcome);
  if (result.evidenceRequest) {
    const request = result.evidenceRequest;
    await deps.repository.saveSession(session(sessionId, request.caseRunId, 'AWAITING_EVIDENCE', request.evidenceRequestId));
    return { sessionId, step: 'AWAITING_EVIDENCE', messages: [...prefix, evidencePrompt(request)], caseRunId: request.caseRunId, outcome, evidenceRequest: requestView(request), actions: { resubmit: canResubmit }, syntheticDataDisclaimer: true };
  }
  const curated = buildChatResponse({ decision: result.decision, businessName: caseRecord?.businessName ?? '', representativeName: caseRecord?.representativeName ?? '', provisional: result.provisional, toolsCalled: result.trace.map((step) => step.tool) });
  await deps.repository.saveSession(session(sessionId, result.decision.caseRunId, 'DONE'));
  return { sessionId, step: 'DONE', messages: [...prefix, curated.output], caseRunId: result.decision.caseRunId, outcome, actions: { resubmit: canResubmit }, syntheticDataDisclaimer: true };
}

async function afterResolution(deps: ChatDependencies, sessionId: string, request: EvidenceRequest, continuation: EvidenceContinuation): Promise<ChatReply> {
  if (continuation.route === 'RESUMED' && continuation.resumedAssessment) {
    return presentAssessment(deps, sessionId, continuation.resumedAssessment, ['Thank you. The additional evidence has resolved the identified gap.\n\nI will now continue from the next incomplete validation check.']);
  }
  const latest = (await deps.repository.getEvidenceRequest(request.evidenceRequestId)) ?? request;
  if (continuation.route === 'RETRY') {
    const gaps = continuation.remainingGaps.length > 0 ? continuation.remainingGaps.map((item) => `• ${item}`).join('\n') : '• Additional supporting evidence is required.';
    const explain = `The evidence does not yet resolve the identified gap.\n\nRemaining requirements:\n${gaps}\n\nPlease provide a revised clarification or document.`;
    await deps.repository.saveSession(session(sessionId, latest.caseRunId, 'AWAITING_EVIDENCE', latest.evidenceRequestId));
    const canResubmit = await resubmitAvailable(deps.repository, latest.caseRunId, 'NEED_MORE_INFORMATION');
    return { sessionId, step: 'AWAITING_EVIDENCE', messages: [explain, evidenceHint], caseRunId: latest.caseRunId, evidenceRequest: requestView(latest), actions: { resubmit: canResubmit }, syntheticDataDisclaimer: true };
  }
  await deps.repository.saveSession(session(sessionId, latest.caseRunId, 'DONE', latest.evidenceRequestId));
  const message = continuation.route === 'ESCALATED_CONTRADICTORY'
    ? 'The new evidence conflicts with previously validated case information.\n\nThe case has been routed to a human evidence reviewer. No automated reconciliation or final adverse decision has been made.'
    : 'The available evidence remains insufficient after the allowed number of attempts.\n\nThe case has been routed to a human evidence reviewer. No final adverse decision has been made.';
  return { sessionId, step: 'DONE', messages: [message], caseRunId: latest.caseRunId, evidenceRequest: requestView(latest), syntheticDataDisclaimer: true };
}

async function requirePending(repository: Repository, sessionId: string): Promise<{ current: ChatSessionState; request: EvidenceRequest }> {
  const current = await repository.getSession(sessionId);
  if (current?.step !== 'AWAITING_EVIDENCE') throw new Error('NO_EVIDENCE_REQUEST_PENDING');
  const request = await repository.getEvidenceRequest(current.evidenceRequestId);
  if (!request) throw new Error('EVIDENCE_REQUEST_NOT_FOUND');
  return { current, request };
}

/** The customer attached one or more documents (and optionally typed a note). Files are stored and text-extracted by the API layer. */
export async function handleChatEvidenceUpload(deps: ChatDependencies, input: { sessionId: string; files: AttachedEvidence[]; note?: string }): Promise<ChatReply> {
  const { request } = await requirePending(deps.repository, input.sessionId);
  if (input.files.length === 0 && !(input.note ?? '').trim()) throw new Error('EVIDENCE_FILE_REQUIRED');
  for (const file of input.files) await submitUploadedEvidence(deps.repository, request.evidenceRequestId, { caseRunId: request.caseRunId, fileName: file.fileName, mimeType: file.mimeType, storageUrl: file.storageUrl, extractedText: file.extractedText, notes: (input.note ?? '').trim(), allowReceived: true });
  if ((input.note ?? '').trim()) await submitTextEvidence(deps.repository, request.evidenceRequestId, { caseRunId: request.caseRunId, text: input.note ?? '', allowReceived: true });
  return afterResolution(deps, input.sessionId, request, await resolveEvidenceAndContinue(deps.repository, deps.agentRuntime, request.evidenceRequestId, request.caseRunId, request.submissionVersion, input.sessionId));
}

async function handleResubmission(deps: ChatDependencies, sessionId: string, caseRunId: string, comments: string): Promise<ChatReply> {
  const { repository, agentRuntime } = deps;
  const original = await repository.getCase(caseRunId);
  const revised = original ? await ensureRevisedCase(repository, original) : undefined;
  if (!original || !revised) {
    return { sessionId, step: 'DONE', messages: ['A corrected version is not available for this case in the synthetic data. Please provide the requested evidence instead.'], caseRunId, syntheticDataDisclaimer: true };
  }
  // The customer is moving to the corrected version: close any evidence request still open on the original.
  for (const request of await repository.getEvidenceRequests(original.caseRunId)) if (['OPEN', 'RECEIVED', 'PARTIALLY_RECEIVED', 'INSUFFICIENT'].includes(request.status)) await cancelEvidenceRequest(repository, request.evidenceRequestId, original.caseRunId);
  const result = await createResubmission(repository, { originalCaseRunId: original.caseRunId, revisedCaseRunId: revised.caseRunId, resubmissionComments: comments.slice(0, 1000) }, agentRuntime);
  return presentAssessment(deps, sessionId, result, [`I've submitted the corrected version as case ${revised.caseRunId}; the original submission is now marked as superseded.`]);
}

export async function handleChatMessage(deps: ChatDependencies, input: { sessionId: string; message: string; caseRunIdHint?: string }): Promise<ChatReply> {
  const { repository, agentRuntime } = deps;
  const sessionId = input.sessionId;
  const message = String(input.message ?? '').trim();
  const upper = message.toUpperCase();
  const current = await repository.getSession(sessionId);

  // Customer asks to submit a corrected version (button or words) — for the case they are working on.
  if (current?.caseRunId && (current.step === 'AWAITING_EVIDENCE' || current.step === 'DONE') && resubmitPattern.test(message) && !/AUTH-\d{3}/i.test(message)) {
    return handleResubmission(deps, sessionId, current.caseRunId, message);
  }

  // Evidence answer: everything typed while a request is open IS the evidence (or a cancel).
  if (current?.step === 'AWAITING_EVIDENCE') {
    const { request } = await requirePending(repository, sessionId);
    if (cancelWords.includes(upper)) {
      await cancelEvidenceRequest(repository, request.evidenceRequestId, request.caseRunId);
      await repository.saveSession(session(sessionId, request.caseRunId, 'DONE', request.evidenceRequestId));
      return { sessionId, step: 'DONE', messages: [cancelledMessage], caseRunId: request.caseRunId, syntheticDataDisclaimer: true };
    }
    if (!message) return { sessionId, step: 'AWAITING_EVIDENCE', messages: ['I did not receive anything.\n\nPlease type your answer or attach a document, or choose "Cancel request".'], caseRunId: request.caseRunId, evidenceRequest: requestView(request), syntheticDataDisclaimer: true };
    await submitTextEvidence(repository, request.evidenceRequestId, { caseRunId: request.caseRunId, text: message, allowReceived: true });
    return afterResolution(deps, sessionId, request, await resolveEvidenceAndContinue(repository, agentRuntime, request.evidenceRequestId, request.caseRunId, request.submissionVersion, sessionId));
  }

  // A named synthetic case ("Evaluate AUTH-001") still works as a shortcut for demos and tests.
  if (/AUTH-\d{3}/i.test(message)) {
    const resolved = resolveCaseRequest(message, sessionId);
    if (!(await repository.getCase(resolved.caseRunId))) return { sessionId, step: 'IDLE', messages: [caseNotFoundMessage(resolved.caseRunId)], caseRunId: resolved.caseRunId, syntheticDataDisclaimer: true };
    return evaluateAndPresent(deps, sessionId, resolved.caseRunId, resolved.chatInput);
  }
  if (input.caseRunIdHint) return evaluateAndPresent(deps, sessionId, input.caseRunIdHint, `${message} ${input.caseRunIdHint}`.trim());

  // Customer-first intake.
  const previous = current?.step === 'INTAKE' ? current.intake : emptyIntake;
  const parsed = extractIntake(message);
  const details: IntakeDetails = {
    representativeName: parsed.representativeName || previous.representativeName || (previous.businessName && !parsed.businessName ? looksLikeBareName(message) : ''),
    businessName: parsed.businessName || previous.businessName || (previous.representativeName && !parsed.representativeName ? looksLikeBareCompany(message) : ''),
    businessIdentifier: parsed.businessIdentifier || previous.businessIdentifier,
  };
  if (current?.step !== 'INTAKE' && !parsed.representativeName && !parsed.businessName) {
    await repository.saveSession(session(sessionId, current?.caseRunId ?? '', 'IDLE'));
    return { sessionId, step: 'IDLE', messages: [introMessage], caseRunId: current?.caseRunId ?? '', syntheticDataDisclaimer: true };
  }
  if (!details.representativeName || !details.businessName) {
    await repository.saveSession(session(sessionId, '', 'INTAKE', '', details));
    const ask = !details.representativeName
      ? `${details.businessName ? `Thanks — I'll note that you represent ${details.businessName}. ` : ''}What is your full name?`
      : `Thanks ${details.representativeName}. Which company are you representing?`;
    return { sessionId, step: 'INTAKE', messages: [ask], caseRunId: '', syntheticDataDisclaimer: true };
  }
  const opened = await openIntakeCase(repository, details);
  const scenarioNote = opened.scenario ? `\n\n*Synthetic prototype: your details were matched to synthetic scenario ${opened.scenario.caseRunId}.*` : '\n\n*Synthetic prototype: no synthetic scenario matched these details.*';
  const result = await evaluateCase(repository, agentRuntime, opened.caseRecord.caseRunId, sessionId, `Evaluate ${opened.caseRecord.caseRunId}`);
  return presentAssessment(deps, sessionId, result, [`Thanks ${opened.caseRecord.representativeName}. I've opened case **${opened.caseRecord.caseRunId}** for ${opened.caseRecord.businessName} and I'm running the checks now.${scenarioNote}`]);
}

async function evaluateAndPresent(deps: ChatDependencies, sessionId: string, caseRunId: string, chatInput: string): Promise<ChatReply> {
  try {
    return await presentAssessment(deps, sessionId, await evaluateCase(deps.repository, deps.agentRuntime, caseRunId, sessionId, chatInput));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CASE_LOCKED')) return { sessionId, step: 'IDLE', messages: [`Case ${caseRunId} has already been reviewed or resubmitted, so it cannot be re-evaluated from the chat. An operator must reset the runtime state to run it again.`], caseRunId, syntheticDataDisclaimer: true };
    throw error;
  }
}
