/**
 * Conversation layer (SBO.01 orchestrator, docs/09). A brand-new customer just chats:
 *
 *   "my name is … I represent …"  → company on record?  no  → NEW LEAD case, nothing verified or approved
 *                                                      yes → case opened, the chatbot asks for Emirates ID, Trade License, Establishment Card
 *   attach documents (PDF / Word / image, in the same window)  → completeness check → SBO.02 runs the five checks
 *   a check needs another document (e.g. POA/MOA) → the same prompt asks for it → attach → the assessment resumes from that check
 *   approve → SBO.11 draft email · reject → SBO.11 draft email + SBO.20 RCA + human confirmation on the review dashboard
 *
 * Evidence is documents only: anything typed while a document request is open is not evidence (the customer is told to attach the document).
 */
import { type AgentRuntime } from '@sbo/agent-runtime';
import { type ChatSessionState, type EvidenceRequest, type IntakeDetails, type RequestType, documentLabels, intakeDocumentTypes, matchRequestType, requestTypeById, requestTypes, stageById } from '@sbo/domain';
import { type Repository, now } from '@sbo/persistence';
import { buildChatResponse, customerReason } from './chat-response.js';
import { cancelEvidenceRequest, cancelWords, readEvidenceDocument, resolveEvidenceAndContinue, submitDocumentEvidence, type EvidenceContinuation } from './evidence.js';
import { captureRequest } from './capture.js';
import { documentRequestMessage, extractIntake, introMessage, looksLikeBareCompany, looksLikeBareName, openIntakeCase } from './intake.js';
import { openEvidenceRequest, type AssessmentResult } from './super-agent.js';

export interface ChatReply {
  sessionId: string;
  step: ChatSessionState['step'];
  messages: string[];
  caseRunId: string;
  /** Curated outcome fields only — never raw prompts, tool JSON, rule rows, or chain-of-thought. */
  outcome?: { governedOutcome: string; primaryReasonCode: string; humanReviewRequired: boolean; provisionalOutcome: string; governanceOverride: boolean; toolsCalled: string[] };
  evidenceRequest?: { evidenceRequestId: string; evidenceChannel: string; requestedItems: string[]; status: string; attemptCount: number; maxAttempts: number };
  /** The request type in play (chosen from the catalog or recognised from the message). */
  requestType?: { id: string; label: string; stage: string; stageName: string; automated: boolean };
  syntheticDataDisclaimer: true;
}

export interface ChatDependencies { repository: Repository; agentRuntime: AgentRuntime; appBaseUrl: string; }
/** An already-stored, already-text-extracted attachment (extraction and storage happen in the API layer). */
export interface AttachedEvidence { fileName: string; mimeType: string; storageUrl: string; extractedText: string; }

const emptyIntake: IntakeDetails = { representativeName: '', businessName: '', businessIdentifier: '' };
export const attachHint = 'Attach the document(s) with the paperclip (PDF, Word or image files). Typed answers are not accepted as evidence. To stop, choose "Cancel request".';
const cancelledMessage = 'The document request has been cancelled.\n\nThe case remains unresolved and no further automated processing has been performed.';

function session(sessionId: string, caseRunId: string, step: ChatSessionState['step'], evidenceRequestId = '', intake: IntakeDetails = emptyIntake, requestTypeId = ''): ChatSessionState { return { sessionId, caseRunId, step, evidenceRequestId, requestTypeId, intake, updatedAt: now() }; }

function outcomeView(result: AssessmentResult): NonNullable<ChatReply['outcome']> {
  return { governedOutcome: result.decision.outcome, primaryReasonCode: result.decision.primaryReasonCode, humanReviewRequired: result.decision.humanReviewRequired, provisionalOutcome: result.provisional.provisionalOutcome, governanceOverride: result.governanceOverride, toolsCalled: result.trace.map((step) => step.tool) };
}
function requestView(request: EvidenceRequest): NonNullable<ChatReply['evidenceRequest']> {
  return { evidenceRequestId: request.evidenceRequestId, evidenceChannel: request.evidenceChannel, requestedItems: request.requestedItems, status: request.status, attemptCount: request.attemptCount, maxAttempts: request.maxAttempts };
}
const evidencePrompt = (request: EvidenceRequest): string => `${request.customerMessage}\n\n${attachHint}`;

/** Present an assessment: a document prompt when the finding is fixable by a document, otherwise the curated response. */
async function presentAssessment(deps: ChatDependencies, sessionId: string, result: AssessmentResult, prefix: string[] = []): Promise<ChatReply> {
  const caseRecord = await deps.repository.getCase(result.decision.caseRunId);
  const outcome = outcomeView(result);
  if (result.evidenceRequest) {
    const request = result.evidenceRequest;
    await deps.repository.saveSession(session(sessionId, request.caseRunId, 'AWAITING_EVIDENCE', request.evidenceRequestId));
    const why = customerReason(result.decision.primaryReasonCode);
    return { sessionId, step: 'AWAITING_EVIDENCE', messages: [...prefix, `${why ? `${why}\n\n` : ''}${evidencePrompt(request)}`], caseRunId: request.caseRunId, outcome, evidenceRequest: requestView(request), syntheticDataDisclaimer: true };
  }
  const curated = buildChatResponse({ decision: result.decision, businessName: caseRecord?.businessName ?? '', representativeName: caseRecord?.representativeName ?? '', provisional: result.provisional, toolsCalled: result.trace.map((step) => step.tool) });
  await deps.repository.saveSession(session(sessionId, result.decision.caseRunId, 'DONE'));
  return { sessionId, step: 'DONE', messages: [...prefix, curated.output], caseRunId: result.decision.caseRunId, outcome, syntheticDataDisclaimer: true };
}

async function afterResolution(deps: ChatDependencies, sessionId: string, request: EvidenceRequest, continuation: EvidenceContinuation): Promise<ChatReply> {
  if (continuation.route === 'RESUMED' && continuation.resumedAssessment) {
    return presentAssessment(deps, sessionId, continuation.resumedAssessment, ['Thank you — I have the documents I need. Running the checks now.']);
  }
  const latest = (await deps.repository.getEvidenceRequest(request.evidenceRequestId)) ?? request;
  if (continuation.route === 'RETRY') {
    const gaps = continuation.remainingGaps.map((item) => `• ${item}`).join('\n');
    await deps.repository.saveSession(session(sessionId, latest.caseRunId, 'AWAITING_EVIDENCE', latest.evidenceRequestId));
    return { sessionId, step: 'AWAITING_EVIDENCE', messages: [`I still need:\n${gaps}`, attachHint], caseRunId: latest.caseRunId, evidenceRequest: requestView(latest), syntheticDataDisclaimer: true };
  }
  await deps.repository.saveSession(session(sessionId, latest.caseRunId, 'DONE', latest.evidenceRequestId));
  return { sessionId, step: 'DONE', messages: ['The documents received still do not cover what is needed after the allowed number of attempts.\n\nThe case has been passed to a human reviewer on the review dashboard. No final adverse decision has been made.'], caseRunId: latest.caseRunId, evidenceRequest: requestView(latest), syntheticDataDisclaimer: true };
}

async function requirePending(repository: Repository, sessionId: string): Promise<{ current: ChatSessionState; request: EvidenceRequest }> {
  const current = await repository.getSession(sessionId);
  if (current?.step !== 'AWAITING_EVIDENCE') throw new Error('NO_EVIDENCE_REQUEST_PENDING');
  const request = await repository.getEvidenceRequest(current.evidenceRequestId);
  if (!request) throw new Error('EVIDENCE_REQUEST_NOT_FOUND');
  return { current, request };
}

/** The customer attached one or more documents. Files are stored and text-extracted by the API layer; every file is checked BEFORE anything is recorded. */
export async function handleChatEvidenceUpload(deps: ChatDependencies, input: { sessionId: string; files: AttachedEvidence[] }): Promise<ChatReply> {
  const { request } = await requirePending(deps.repository, input.sessionId);
  if (input.files.length === 0) throw new Error('EVIDENCE_FILE_REQUIRED');
  for (const file of input.files) readEvidenceDocument(file.extractedText);
  for (const file of input.files) await submitDocumentEvidence(deps.repository, request.evidenceRequestId, { caseRunId: request.caseRunId, fileName: file.fileName, mimeType: file.mimeType, storageUrl: file.storageUrl, extractedText: file.extractedText, allowReceived: true });
  return afterResolution(deps, input.sessionId, request, await resolveEvidenceAndContinue(deps.repository, deps.agentRuntime, request.evidenceRequestId, request.caseRunId, request.submissionVersion, input.sessionId));
}

/** What the conversation is waiting for right now (used when the page is opened or reloaded, e.g. after a reviewer reopened the case). */
export async function describeChatState(repository: Repository, sessionId: string): Promise<ChatReply | undefined> {
  const current = await repository.getSession(sessionId);
  if (current?.step !== 'AWAITING_EVIDENCE') return undefined;
  const request = await repository.getEvidenceRequest(current.evidenceRequestId);
  if (!request) return undefined;
  return { sessionId, step: 'AWAITING_EVIDENCE', messages: [evidencePrompt(request)], caseRunId: request.caseRunId, evidenceRequest: requestView(request), syntheticDataDisclaimer: true };
}

/** A bare reply that reads like a company name (legal-form word), used when nothing has been said about either name or company yet. */
const looksLikeCompany = (text: string): boolean => /\b(?:llc|l\.l\.c|ltd|limited|fz-?llc|fzco|pty|inc|co|company|group|trading|holdings|services|solutions|enterprises|contracting|logistics|consulting)\b/i.test(text);
const requestView2 = (entry: RequestType): NonNullable<ChatReply['requestType']> => ({ id: entry.id, label: entry.label, stage: entry.stage, stageName: stageById(entry.stage)?.name ?? '', automated: entry.automated });
const notAutomated = (entry: RequestType): string => `This request type is not automated in this prototype yet: I'll capture it and route it to the **${stageById(entry.stage)?.name ?? ''}** team, and no checks will run.`;

export async function handleChatMessage(deps: ChatDependencies, input: { sessionId: string; message: string; intent?: string }): Promise<ChatReply> {
  const { repository } = deps;
  const sessionId = input.sessionId;
  const message = String(input.message ?? '').trim();
  const upper = message.toUpperCase();
  const current = await repository.getSession(sessionId);

  // A document request is open: only documents count. Typed text is not evidence; "cancel" ends the request.
  if (current?.step === 'AWAITING_EVIDENCE') {
    const { request } = await requirePending(repository, sessionId);
    if (cancelWords.includes(upper)) {
      await cancelEvidenceRequest(repository, request.evidenceRequestId, request.caseRunId);
      await repository.saveSession(session(sessionId, request.caseRunId, 'DONE', request.evidenceRequestId));
      return { sessionId, step: 'DONE', messages: [cancelledMessage], caseRunId: request.caseRunId, syntheticDataDisclaimer: true };
    }
    return { sessionId, step: 'AWAITING_EVIDENCE', messages: [`Typed text can't be used as evidence — I need the document itself.\n\n${evidencePrompt(request)}`], caseRunId: request.caseRunId, evidenceRequest: requestView(request), syntheticDataDisclaimer: true };
  }

  // What is the customer asking for? A catalog choice wins, then one carried in the conversation, then a keyword match on a message with no introduction in it.
  const previous = current?.step === 'INTAKE' ? current.intake : emptyIntake;
  const asked = matchRequestType(message);
  // A ready-made question ("I want to port our mobile numbers to you from another operator.") is a request, never an introduction.
  const parsed = requestTypes.some((entry) => entry.query === message.trim()) ? {} : extractIntake(message);
  const introduced = Boolean(parsed.representativeName || parsed.businessName);
  const chosen: RequestType | undefined = (input.intent ? requestTypeById(input.intent) : undefined) ?? (current?.step === 'INTAKE' ? requestTypeById(current.requestTypeId) : undefined) ?? asked;
  const requestTypeId = chosen?.id ?? '';
  const requestReply = chosen ? { requestType: requestView2(chosen) } : {};

  // A request was named but nobody has introduced themselves yet: acknowledge it and ask who is asking.
  if (chosen && !introduced && (input.intent || current?.step !== 'INTAKE')) {
    await repository.saveSession(session(sessionId, '', 'INTAKE', '', emptyIntake, requestTypeId));
    return { sessionId, step: 'INTAKE', messages: [`Happy to help with **${chosen.label}**.${chosen.automated ? '' : `\n\n${notAutomated(chosen)}`}\n\nFirst, please tell me **your name** and **the company you represent**.`], caseRunId: '', ...requestReply, syntheticDataDisclaimer: true };
  }

  // Customer-first intake.
  const details: IntakeDetails = {
    representativeName: parsed.representativeName || previous.representativeName || (previous.businessName && !parsed.businessName ? looksLikeBareName(message) : !previous.representativeName && current?.step === 'INTAKE' && !parsed.businessName && !looksLikeCompany(message) ? looksLikeBareName(message) : ''),
    businessName: parsed.businessName || previous.businessName || (previous.representativeName && !parsed.representativeName ? looksLikeBareCompany(message) : !previous.businessName && current?.step === 'INTAKE' && !parsed.representativeName && looksLikeCompany(message) ? looksLikeBareCompany(message) : ''),
    businessIdentifier: '',
  };
  if (current?.step !== 'INTAKE' && !introduced) {
    await repository.saveSession(session(sessionId, current?.caseRunId ?? '', 'IDLE'));
    return { sessionId, step: 'IDLE', messages: [introMessage], caseRunId: current?.caseRunId ?? '', syntheticDataDisclaimer: true };
  }
  if (!details.representativeName || !details.businessName) {
    await repository.saveSession(session(sessionId, '', 'INTAKE', '', details, requestTypeId));
    const ask = !details.representativeName
      ? `${details.businessName ? `Thanks — I'll note that you represent ${details.businessName}. ` : ''}What is your full name?`
      : `Thanks ${details.representativeName}. Which company are you representing?`;
    return { sessionId, step: 'INTAKE', messages: [ask], caseRunId: '', ...requestReply, syntheticDataDisclaimer: true };
  }
  const opened = await openIntakeCase(repository, details, requestTypeId);
  const { caseRecord } = opened;
  if (opened.kind === 'NEW_LEAD') {
    await repository.saveSession(session(sessionId, caseRecord.caseRunId, 'DONE'));
    return { sessionId, step: 'DONE', messages: [`Thanks ${caseRecord.representativeName}. I couldn't find **${caseRecord.businessName}** in our records, so I've created **new lead case ${caseRecord.caseRunId}** for it.\n\nNo checks have been run and nothing has been approved: your details are unverified. A specialist will follow up to onboard the business before any request can be handled.\n\n*Synthetic prototype. No production-system update or customer communication has been performed.*`], caseRunId: caseRecord.caseRunId, ...requestReply, syntheticDataDisclaimer: true };
  }
  // A request type that is not automated yet: capture it and route it to the stage that owns it.
  if (chosen && !chosen.automated) {
    const routed = await captureRequest(repository, caseRecord, chosen, sessionId);
    await repository.saveSession(session(sessionId, caseRecord.caseRunId, 'DONE'));
    return { sessionId, step: 'DONE', messages: [`Thanks ${caseRecord.representativeName}. I've captured **${chosen.label}** as case **${caseRecord.caseRunId}** for ${caseRecord.businessName} and routed it to the **${routed.stageName}** team.\n\nThis request type is not automated in this prototype yet, so **no checks have been run and nothing has been approved or changed**. A specialist will pick it up.\n\n*Synthetic prototype. No production-system update or customer communication has been performed.*`], caseRunId: caseRecord.caseRunId, requestType: requestView2(chosen), syntheticDataDisclaimer: true };
  }
  const request = await openEvidenceRequest(repository, { caseRunId: caseRecord.caseRunId, submissionVersion: caseRecord.submissionVersion, sessionId, originatingCheckType: 'DOCUMENT_INTAKE', reasonCode: 'DOCUMENTS_REQUIRED', requestedItems: intakeDocumentTypes.map((type) => documentLabels[type]), previousState: 'CASE_OPENED', message: documentRequestMessage(caseRecord.representativeName, caseRecord.businessName) });
  await repository.saveSession(session(sessionId, caseRecord.caseRunId, 'AWAITING_EVIDENCE', request.evidenceRequestId, emptyIntake, requestTypeId));
  return { sessionId, step: 'AWAITING_EVIDENCE', messages: [`I've opened case **${caseRecord.caseRunId}**.\n\n${evidencePrompt(request)}`], caseRunId: caseRecord.caseRunId, evidenceRequest: requestView(request), ...requestReply, syntheticDataDisclaimer: true };
}