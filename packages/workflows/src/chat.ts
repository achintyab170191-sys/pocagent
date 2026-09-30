/**
 * Workflow 03 conversational layer: Agentic Chat trigger, evidence-method selection, TEXT/UPLOAD paths, cancel, retry loop.
 * The n8n `sendAndWait` pauses become a persisted ChatSessionState (chat_sessions) so the API is stateless between requests.
 */
import { type AgentRuntime } from '@sbo/agent-runtime';
import { type ChatSessionState, type EvidenceRequest } from '@sbo/domain';
import { type Repository, now } from '@sbo/persistence';
import { buildChatResponse } from './chat-response.js';
import { cancelEvidenceRequest, cancelWords, resolveEvidenceAndContinue, submitTextEvidence, type EvidenceContinuation } from './evidence.js';
import { caseNotFoundMessage, evaluateCase, invalidRequestMessage, resolveCaseRequest, type AssessmentResult } from './super-agent.js';

export interface ChatReply {
  sessionId: string;
  step: ChatSessionState['step'];
  messages: string[];
  caseRunId: string;
  /** Curated outcome fields only — never raw prompts, tool JSON, rule rows, or chain-of-thought. */
  outcome?: { governedOutcome: string; primaryReasonCode: string; humanReviewRequired: boolean; provisionalOutcome: string; governanceOverride: boolean; toolsCalled: string[] };
  evidenceRequest?: { evidenceRequestId: string; evidenceChannel: string; requestedItems: string[]; status: string; attemptCount: number; maxAttempts: number; uploadUrl?: string };
  syntheticDataDisclaimer: true;
}

const methodPrompt = 'Additional evidence is required to continue this assessment.\n\nChoose how you would like to provide it:\n\n• Reply TEXT to enter the clarification directly in this chat.\n• Reply UPLOAD to provide a supporting PDF.\n\nPlease reply with TEXT or UPLOAD.';
const methodRetryPrompt = 'I could not identify the evidence method from your response.\n\nPlease reply with exactly one of these:\n\nTEXT — paste the evidence directly into this chat\n\nUPLOAD — upload a supporting PDF';
const methodFailed = 'I still could not identify whether you want to provide text evidence or upload a file.\n\nThe case will remain in WAITING_FOR_EVIDENCE status.\n\nYou can restart the evidence interaction later.';

export function normaliseEvidenceMethod(response: string): 'FILE_UPLOAD' | 'CHAT_TEXT' | '' {
  const upper = String(response).trim().toUpperCase();
  if (['UPLOAD', 'FILE', 'DOCUMENT', 'PDF'].includes(upper)) return 'FILE_UPLOAD';
  if (['TEXT', 'CHAT', 'PASTE', 'TYPE'].includes(upper)) return 'CHAT_TEXT';
  return '';
}

export function uploadUrlFor(appBaseUrl: string, request: Pick<EvidenceRequest, 'evidenceRequestId' | 'caseRunId'>): string {
  return `${appBaseUrl.replace(/\/$/, '')}/upload?evidence_request_id=${encodeURIComponent(request.evidenceRequestId)}&case_run_id=${encodeURIComponent(request.caseRunId)}`;
}

const askText = (request: EvidenceRequest): string => `${request.customerMessage}\n\nEnter the requested clarification below.\nType CANCEL to stop this evidence request.`;
const askUpload = (request: EvidenceRequest, appBaseUrl: string): string => `Additional documentary evidence is required to continue case ${request.caseRunId}.\n\nUpload a supporting PDF using this secure prototype form:\n${uploadUrlFor(appBaseUrl, request)}\n\nAfter submitting the form, return here and reply UPLOADED.\nType CANCEL to stop.`;

export interface ChatDependencies { repository: Repository; agentRuntime: AgentRuntime; appBaseUrl: string; }

function session(sessionId: string, caseRunId: string, step: ChatSessionState['step'], evidenceRequestId = '', methodAttempts = 0): ChatSessionState { return { sessionId, caseRunId, step, evidenceRequestId, methodAttempts, updatedAt: now() }; }

function outcomeView(result: AssessmentResult): NonNullable<ChatReply['outcome']> {
  return { governedOutcome: result.decision.outcome, primaryReasonCode: result.decision.primaryReasonCode, humanReviewRequired: result.decision.humanReviewRequired, provisionalOutcome: result.provisional.provisionalOutcome, governanceOverride: result.governanceOverride, toolsCalled: result.trace.map((step) => step.tool) };
}
function requestView(request: EvidenceRequest, appBaseUrl: string): NonNullable<ChatReply['evidenceRequest']> {
  return { evidenceRequestId: request.evidenceRequestId, evidenceChannel: request.evidenceChannel, requestedItems: request.requestedItems, status: request.status, attemptCount: request.attemptCount, maxAttempts: request.maxAttempts, uploadUrl: request.evidenceChannel === 'FILE_UPLOAD' ? uploadUrlFor(appBaseUrl, request) : undefined };
}

/** Present an assessment: evidence prompt when the decision is customer-remediable ("Select Evidence Channel"), otherwise the curated response. */
async function presentAssessment(deps: ChatDependencies, sessionId: string, result: AssessmentResult, prefix: string[] = []): Promise<ChatReply> {
  const caseRecord = await deps.repository.getCase(result.decision.caseRunId);
  const outcome = outcomeView(result);
  if (result.evidenceRequest) {
    const request = result.evidenceRequest;
    const channel = request.evidenceChannel;
    const [message, step] = channel === 'CHAT_TEXT' ? [askText(request), 'AWAITING_TEXT' as const] : channel === 'FILE_UPLOAD' ? [askUpload(request, deps.appBaseUrl), 'AWAITING_UPLOAD' as const] : [methodPrompt, 'AWAITING_METHOD' as const];
    await deps.repository.saveSession(session(sessionId, request.caseRunId, step, request.evidenceRequestId));
    return { sessionId, step, messages: [...prefix, message], caseRunId: request.caseRunId, outcome, evidenceRequest: requestView(request, deps.appBaseUrl), syntheticDataDisclaimer: true };
  }
  const curated = buildChatResponse({ decision: result.decision, businessName: caseRecord?.businessName ?? '', representativeName: caseRecord?.representativeName ?? '', provisional: result.provisional, toolsCalled: result.trace.map((step) => step.tool) });
  await deps.repository.saveSession(session(sessionId, result.decision.caseRunId, 'DONE'));
  return { sessionId, step: 'DONE', messages: [...prefix, curated.output], caseRunId: result.decision.caseRunId, outcome, syntheticDataDisclaimer: true };
}

async function afterResolution(deps: ChatDependencies, sessionId: string, request: EvidenceRequest, continuation: EvidenceContinuation): Promise<ChatReply> {
  if (continuation.route === 'RESUMED' && continuation.resumedAssessment) {
    return presentAssessment(deps, sessionId, continuation.resumedAssessment, ['Thank you. The additional evidence has resolved the identified gap.\n\nI will now continue from the next incomplete validation check.']);
  }
  const latest = (await deps.repository.getEvidenceRequest(request.evidenceRequestId)) ?? request;
  if (continuation.route === 'RETRY') {
    const gaps = continuation.remainingGaps.length > 0 ? continuation.remainingGaps.map((item) => `• ${item}`).join('\n') : '• Additional supporting evidence is required.';
    const explain = `The evidence does not yet resolve the identified gap.\n\nRemaining requirements:\n${gaps}\n\nPlease provide a revised clarification or document.`;
    const channel = latest.evidenceChannel;
    const [message, step] = channel === 'CHAT_TEXT' ? [askText(latest), 'AWAITING_TEXT' as const] : channel === 'FILE_UPLOAD' ? [askUpload(latest, deps.appBaseUrl), 'AWAITING_UPLOAD' as const] : [methodPrompt, 'AWAITING_METHOD' as const];
    await deps.repository.saveSession(session(sessionId, latest.caseRunId, step, latest.evidenceRequestId));
    return { sessionId, step, messages: [explain, message], caseRunId: latest.caseRunId, evidenceRequest: requestView(latest, deps.appBaseUrl), syntheticDataDisclaimer: true };
  }
  await deps.repository.saveSession(session(sessionId, latest.caseRunId, 'DONE', latest.evidenceRequestId));
  const message = continuation.route === 'ESCALATED_CONTRADICTORY'
    ? 'The new evidence conflicts with previously validated case information.\n\nThe case has been routed to a human evidence reviewer. No automated reconciliation or final adverse decision has been made.'
    : 'The available evidence remains insufficient after the allowed number of attempts.\n\nThe case has been routed to a human evidence reviewer. No final adverse decision has been made.';
  return { sessionId, step: 'DONE', messages: [message], caseRunId: latest.caseRunId, evidenceRequest: requestView(latest, deps.appBaseUrl), syntheticDataDisclaimer: true };
}

export async function handleChatMessage(deps: ChatDependencies, input: { sessionId: string; message: string; caseRunIdHint?: string }): Promise<ChatReply> {
  const { repository, agentRuntime } = deps;
  const sessionId = input.sessionId;
  const message = String(input.message ?? '').trim();
  const current = await repository.getSession(sessionId);
  const upper = message.toUpperCase();
  const pending = current && ['AWAITING_METHOD', 'AWAITING_TEXT', 'AWAITING_UPLOAD'].includes(current.step) ? current : undefined;
  if (pending) {
    const request = await repository.getEvidenceRequest(pending.evidenceRequestId);
    if (!request) throw new Error('EVIDENCE_REQUEST_NOT_FOUND');
    const cancelIfRequested = async (text: string): Promise<ChatReply | undefined> => {
      if (!cancelWords.includes(upper)) return undefined;
      await cancelEvidenceRequest(repository, request.evidenceRequestId, request.caseRunId);
      await repository.saveSession(session(sessionId, request.caseRunId, 'DONE', request.evidenceRequestId));
      return { sessionId, step: 'DONE', messages: [text], caseRunId: request.caseRunId, syntheticDataDisclaimer: true };
    };
    if (pending.step === 'AWAITING_METHOD') {
      const method = normaliseEvidenceMethod(message);
      if (!method) {
        if (pending.methodAttempts === 0) { await repository.saveSession(session(sessionId, request.caseRunId, 'AWAITING_METHOD', request.evidenceRequestId, 1)); return { sessionId, step: 'AWAITING_METHOD', messages: [methodRetryPrompt], caseRunId: request.caseRunId, evidenceRequest: requestView(request, deps.appBaseUrl), syntheticDataDisclaimer: true }; }
        await repository.saveSession(session(sessionId, request.caseRunId, 'IDLE', request.evidenceRequestId, 2));
        return { sessionId, step: 'IDLE', messages: [methodFailed], caseRunId: request.caseRunId, evidenceRequest: requestView(request, deps.appBaseUrl), syntheticDataDisclaimer: true };
      }
      const step = method === 'CHAT_TEXT' ? 'AWAITING_TEXT' : 'AWAITING_UPLOAD';
      await repository.saveSession(session(sessionId, request.caseRunId, step, request.evidenceRequestId));
      return { sessionId, step, messages: [method === 'CHAT_TEXT' ? askText(request) : askUpload(request, deps.appBaseUrl)], caseRunId: request.caseRunId, evidenceRequest: requestView(request, deps.appBaseUrl), syntheticDataDisclaimer: true };
    }
    if (pending.step === 'AWAITING_TEXT') {
      const cancelled = await cancelIfRequested('The additional-evidence request has been cancelled.\n\nThe case remains unresolved and no further automated processing has been performed.');
      if (cancelled) return cancelled;
      if (!message) return { sessionId, step: 'AWAITING_TEXT', messages: ['I did not receive any evidence text.\n\nPlease enter the requested information, or type CANCEL to stop.'], caseRunId: request.caseRunId, evidenceRequest: requestView(request, deps.appBaseUrl), syntheticDataDisclaimer: true };
      await submitTextEvidence(repository, request.evidenceRequestId, { caseRunId: request.caseRunId, text: message });
      return afterResolution(deps, sessionId, request, await resolveEvidenceAndContinue(repository, agentRuntime, request.evidenceRequestId, request.caseRunId, request.submissionVersion, sessionId));
    }
    // AWAITING_UPLOAD: any non-cancel reply triggers the "Get Uploaded Evidence" check.
    const cancelled = await cancelIfRequested('The evidence-upload request has been cancelled.\n\nThe case remains unresolved, and no further automated processing has been performed.');
    if (cancelled) return cancelled;
    const uploaded = (await repository.getEvidence(request.evidenceRequestId)).filter((record) => record.validationStatus === 'RECEIVED');
    if (uploaded.length === 0) return { sessionId, step: 'AWAITING_UPLOAD', messages: [`I could not find an uploaded evidence record for request ${request.evidenceRequestId}.\n\nPlease complete the upload form here:\n${uploadUrlFor(deps.appBaseUrl, request)}\n\nAfter submitting the form, reply UPLOADED.\nType CANCEL to stop.`], caseRunId: request.caseRunId, evidenceRequest: requestView(request, deps.appBaseUrl), syntheticDataDisclaimer: true };
    return afterResolution(deps, sessionId, request, await resolveEvidenceAndContinue(repository, agentRuntime, request.evidenceRequestId, request.caseRunId, request.submissionVersion, sessionId));
  }
  // Fresh chat turn: "Resolve Case Request".
  const hinted = /AUTH-\d{3}/i.test(message) || !input.caseRunIdHint ? message : `${message} ${input.caseRunIdHint}`;
  const resolved = resolveCaseRequest(hinted, sessionId);
  if (!resolved.caseIdFound) return { sessionId, step: 'IDLE', messages: [invalidRequestMessage], caseRunId: '', syntheticDataDisclaimer: true };
  if (!(await repository.getCase(resolved.caseRunId))) return { sessionId, step: 'IDLE', messages: [caseNotFoundMessage(resolved.caseRunId)], caseRunId: resolved.caseRunId, syntheticDataDisclaimer: true };
  let result: AssessmentResult;
  try { result = await evaluateCase(repository, agentRuntime, resolved.caseRunId, sessionId, resolved.chatInput); } catch (error) {
    if (error instanceof Error && error.message.startsWith('CASE_LOCKED')) return { sessionId, step: 'IDLE', messages: [`Case ${resolved.caseRunId} has already been reviewed or resubmitted, so it cannot be re-evaluated from the chat. An operator must reset the runtime state to run it again.`], caseRunId: resolved.caseRunId, syntheticDataDisclaimer: true };
    throw error;
  }
  return presentAssessment(deps, sessionId, result);
}
