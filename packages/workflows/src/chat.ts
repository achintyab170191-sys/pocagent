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
import { type ChatSessionState, type EvidenceRequest, type IntakeDetails, type RequestType, documentLabels, findKnownBusiness, intakeDocumentTypes, matchRequestType, requestTypeById, requestTypes, stageById, suggestKnownBusinesses } from '@sbo/domain';
import { type Repository, now } from '@sbo/persistence';
import { buildChatResponse, customerReason } from './chat-response.js';
import { assessDocuments, cancelEvidenceRequest, cancelWords, readEvidenceDocument, resolveEvidenceAndContinue, submitDocumentEvidence, type EvidenceContinuation } from './evidence.js';
import { captureNewLead, captureRequest } from './capture.js';
import { reopenCase } from './reopen.js';
import { classifyCase, findPriorCase, resumeCancelledCase, type PriorCase } from './returning.js';
import { documentRequestMessage, extractIntake, introMessage, isFullName, looksLikeBareCompany, looksLikeBareName, openIntakeCase } from './intake.js';
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
  const waiting = await deps.repository.getSession(input.sessionId);
  if (waiting?.step === 'REOPEN_PROOF') {
    // A closed, human-confirmed rejection: the customer furnishes proof. Every file is checked first; only then is the case reopened as a new version.
    if (input.files.length === 0) throw new Error('EVIDENCE_FILE_REQUIRED');
    for (const file of input.files) readEvidenceDocument(file.extractedText);
    await reopenCase(deps.repository, { caseRunId: waiting.caseRunId, reviewerName: 'Customer (chat)', comments: 'The customer furnished proof in the chat.', initiatedBy: 'CUSTOMER', sessionId: input.sessionId });
  }
  const { request } = await requirePending(deps.repository, input.sessionId);
  if (input.files.length === 0) throw new Error('EVIDENCE_FILE_REQUIRED');
  for (const file of input.files) readEvidenceDocument(file.extractedText);
  for (const file of input.files) await submitDocumentEvidence(deps.repository, request.evidenceRequestId, { caseRunId: request.caseRunId, fileName: file.fileName, mimeType: file.mimeType, storageUrl: file.storageUrl, extractedText: file.extractedText, allowReceived: true });
  return afterResolution(deps, input.sessionId, request, await resolveEvidenceAndContinue(deps.repository, deps.agentRuntime, request.evidenceRequestId, request.caseRunId, request.submissionVersion, input.sessionId));
}

/** What the conversation is waiting for right now (used when the page is opened or reloaded, e.g. after a reviewer reopened the case). */
export async function describeChatState(repository: Repository, sessionId: string): Promise<ChatReply | undefined> {
  const current = await repository.getSession(sessionId);
  if (current?.step === 'CONFIRM_REOPEN') return { sessionId, step: 'INTAKE', messages: [`Would you like to **reopen** case **${current.caseRunId}**? Reply **yes** to reopen it, or **no** to leave it closed.`], caseRunId: current.caseRunId, syntheticDataDisclaimer: true };
  if (current?.step === 'CONFIRM_COMPANY') return { sessionId, step: 'INTAKE', messages: [didYouMeanMessage(current.intake.businessName, (current.intake.suggestedBusiness ?? '').split('|').filter(Boolean))], caseRunId: '', syntheticDataDisclaimer: true };
  if (current?.step === 'CONFIRM_LEAD') return { sessionId, step: 'INTAKE', messages: [confirmLeadMessage(current.intake.businessName)], caseRunId: '', syntheticDataDisclaimer: true };
  if (current?.step === 'REOPEN_PROOF') return { sessionId, step: 'AWAITING_EVIDENCE', messages: [reopenPrompt(current.caseRunId)], caseRunId: current.caseRunId, evidenceRequest: proofRequestView(), syntheticDataDisclaimer: true };
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

  // The customer typed only part of a company name (or a near miss): confirm which registered company they meant before anything else.
  if (current?.step === 'CONFIRM_COMPANY') {
    const pending = current.intake;
    const candidates = (pending.suggestedBusiness ?? '').split('|').filter(Boolean);
    const pendingType = requestTypeById(current.requestTypeId);
    const pendingReply = pendingType ? { requestType: requestView2(pendingType) } : {};
    const settled: IntakeDetails = { ...pending, suggestedBusiness: '' };
    if (cancelWords.includes(upper)) {
      await repository.saveSession(session(sessionId, '', 'DONE'));
      return { sessionId, step: 'DONE', messages: ['No problem — I have not created anything. Start again whenever you are ready.'], caseRunId: '', ...pendingReply, syntheticDataDisclaimer: true };
    }
    if (yesWords.test(message) && candidates.length === 1) return proceed(deps, sessionId, { ...settled, businessName: candidates[0]! }, pendingType, current.requestTypeId, pendingReply);
    if (noWords.test(message)) {
      await repository.saveSession(session(sessionId, '', 'CONFIRM_LEAD', '', settled, current.requestTypeId));
      return { sessionId, step: 'INTAKE', messages: [confirmLeadMessage(pending.businessName)], caseRunId: '', ...pendingReply, syntheticDataDisclaimer: true };
    }
    const chosenName = extractIntake(message).businessName || looksLikeBareCompany(message);
    if (chosenName) return proceed(deps, sessionId, { ...settled, businessName: chosenName }, pendingType, current.requestTypeId, pendingReply);
    return { sessionId, step: 'INTAKE', messages: [didYouMeanMessage(pending.businessName, candidates)], caseRunId: '', ...pendingReply, syntheticDataDisclaimer: true };
  }
  // The customer is confirming (or correcting) the name of a company that is not on record, before a lead is created.
  if (current?.step === 'CONFIRM_LEAD') {
    const pending = current.intake;
    const pendingType = requestTypeById(current.requestTypeId);
    const pendingReply = pendingType ? { requestType: requestView2(pendingType) } : {};
    if (cancelWords.includes(upper)) {
      await repository.saveSession(session(sessionId, '', 'DONE'));
      return { sessionId, step: 'DONE', messages: ['No problem — I have not created anything. Start again whenever you are ready.'], caseRunId: '', ...pendingReply, syntheticDataDisclaimer: true };
    }
    if (yesWords.test(message)) return createLead(deps, sessionId, pending, current.requestTypeId, pendingReply);
    if (noWords.test(message)) {
      await repository.saveSession(session(sessionId, '', 'INTAKE', '', { ...pending, businessName: '' }, current.requestTypeId));
      return { sessionId, step: 'INTAKE', messages: ['Thanks for checking. What is the correct name of the company you represent?'], caseRunId: '', ...pendingReply, syntheticDataDisclaimer: true };
    }
    const corrected = extractIntake(message).businessName || looksLikeBareCompany(message);
    if (corrected) return proceed(deps, sessionId, { ...pending, businessName: corrected }, pendingType, current.requestTypeId, pendingReply);
    return { sessionId, step: 'INTAKE', messages: [confirmLeadMessage(pending.businessName)], caseRunId: '', ...pendingReply, syntheticDataDisclaimer: true };
  }

  // A closed case: the customer decides whether to reopen it. Yes → the same case asks for its documents again (cancelled request) or waits for proof (closed by a reviewer); no → it stays closed.
  if (current?.step === 'CONFIRM_REOPEN') {
    if (cancelWords.includes(upper) || noWords.test(message)) {
      await repository.saveSession(session(sessionId, current.caseRunId, 'DONE'));
      return { sessionId, step: 'DONE', messages: [`Understood — case ${current.caseRunId} stays closed. Start again whenever you are ready.`], caseRunId: current.caseRunId, syntheticDataDisclaimer: true };
    }
    if (yesWords.test(message)) {
      const caseRecord = await repository.getCase(current.caseRunId);
      const prior = caseRecord ? await classifyCase(repository, caseRecord) : undefined;
      if (prior?.kind === 'CLOSED' && prior.how === 'CANCELLED') {
        const request = await resumeCancelledCase(repository, current.caseRunId, sessionId);
        await repository.saveSession(session(sessionId, current.caseRunId, 'AWAITING_EVIDENCE', request.evidenceRequestId));
        return { sessionId, step: 'AWAITING_EVIDENCE', messages: [`I've reopened case **${current.caseRunId}**.\n\n${evidencePrompt(request)}`], caseRunId: current.caseRunId, evidenceRequest: requestView(request), syntheticDataDisclaimer: true };
      }
      if (prior?.kind === 'CLOSED') {
        await repository.saveSession(session(sessionId, current.caseRunId, 'REOPEN_PROOF'));
        return { sessionId, step: 'AWAITING_EVIDENCE', messages: [`Good.\n\n${reopenPrompt(current.caseRunId)}`], caseRunId: current.caseRunId, evidenceRequest: proofRequestView(), syntheticDataDisclaimer: true };
      }
      if (prior && caseRecord) return presentPriorCase(deps, sessionId, caseRecord.representativeName, prior, '', {}); // it is no longer closed (for example a reviewer reopened it): report where it stands
      await repository.saveSession(session(sessionId, current.caseRunId, 'DONE'));
      return { sessionId, step: 'DONE', messages: [`Case ${current.caseRunId} cannot be reopened.`], caseRunId: current.caseRunId, syntheticDataDisclaimer: true };
    }
    return { sessionId, step: 'INTAKE', messages: [`Please reply **yes** to reopen case **${current.caseRunId}**, or **no** to leave it closed.`], caseRunId: current.caseRunId, syntheticDataDisclaimer: true };
  }
  // A closed rejection is open to the customer again once they furnish proof: only documents count, and "cancel" leaves it closed.
  if (current?.step === 'REOPEN_PROOF') {
    if (cancelWords.includes(upper)) {
      await repository.saveSession(session(sessionId, current.caseRunId, 'DONE'));
      return { sessionId, step: 'DONE', messages: [`Understood — case ${current.caseRunId} stays closed.`], caseRunId: current.caseRunId, syntheticDataDisclaimer: true };
    }
    return { sessionId, step: 'AWAITING_EVIDENCE', messages: [`Typed text can't be used as evidence — I need the document itself.\n\n${reopenPrompt(current.caseRunId)}`], caseRunId: current.caseRunId, evidenceRequest: proofRequestView(), syntheticDataDisclaimer: true };
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
    return { sessionId, step: 'INTAKE', messages: [`Happy to help with **${chosen.label}**.${chosen.automated ? '' : `\n\n${notAutomated(chosen)}`}\n\nFirst, please tell me **your full name** and **the company you represent**.`], caseRunId: '', ...requestReply, syntheticDataDisclaimer: true };
  }

  // Customer-first intake. A single-word name is asked for again as a full name; a bare reply then replaces it.
  const nameIsPartial = Boolean(previous.representativeName) && !isFullName(previous.representativeName);
  const bareName = looksLikeBareName(message);
  const namesThem = !parsed.representativeName && nameIsPartial && Boolean(bareName) && !looksLikeCompany(message); // this reply completes the earlier partial name
  const details: IntakeDetails = {
    representativeName: parsed.representativeName || (namesThem ? bareName : '') || previous.representativeName || (previous.businessName && !parsed.businessName ? bareName : !previous.representativeName && current?.step === 'INTAKE' && !parsed.businessName && !looksLikeCompany(message) ? bareName : ''),
    businessName: parsed.businessName || previous.businessName || (previous.representativeName && !parsed.representativeName && !namesThem ? looksLikeBareCompany(message) : !previous.businessName && current?.step === 'INTAKE' && !parsed.representativeName && looksLikeCompany(message) ? looksLikeBareCompany(message) : ''),
    businessIdentifier: '',
  };
  if (current?.step !== 'INTAKE' && !introduced) {
    await repository.saveSession(session(sessionId, current?.caseRunId ?? '', 'IDLE'));
    return { sessionId, step: 'IDLE', messages: [introMessage], caseRunId: current?.caseRunId ?? '', syntheticDataDisclaimer: true };
  }
  if (!details.representativeName || !isFullName(details.representativeName) || !details.businessName) {
    await repository.saveSession(session(sessionId, '', 'INTAKE', '', details, requestTypeId));
    const noted = details.businessName ? `I'll note that you represent ${details.businessName}. ` : '';
    const ask = !details.representativeName
      ? `${noted}What is your full name?`
      : !isFullName(details.representativeName)
        ? `Thanks ${details.representativeName}. ${noted}Could you give me your **full name** — first and last name, as it appears on your Emirates ID?`
        : `Thanks ${details.representativeName}. Which company are you representing?`;
    return { sessionId, step: 'INTAKE', messages: [ask], caseRunId: '', ...requestReply, syntheticDataDisclaimer: true };
  }
  return proceed(deps, sessionId, details, chosen, requestTypeId, requestReply);
}

const yesWords = /^\s*(?:yes|y|yeah|yep|yup|sure|ok|okay|correct|confirm|confirmed|right|that(?:'s| is) (?:right|correct)|go ahead|please do)\b/i;
const noWords = /^\s*(?:no|n|nope|nah|wrong|incorrect|not (?:right|correct))\b/i;
const didYouMeanMessage = (typed: string, candidates: string[]): string => candidates.length === 1
  ? `I couldn't find an exact match for **${typed}**. Did you mean **${candidates[0]}**?\n\nReply **yes** to continue with it, **no** to register **${typed}** as a new business, or type the correct company name.`
  : `I couldn't find an exact match for **${typed}**, but these registered companies are close:\n\n${candidates.map((name) => `- ${name}`).join('\n')}\n\nType the full name of the one you mean, or reply **no** to register **${typed}** as a new business.`;
const confirmLeadMessage = (businessName: string): string => `I couldn't find **${businessName}** in our records.\n\nBefore I register it as a new business lead, please confirm the company name is right. Reply **yes** to confirm, or type the correct company name.`;
const reopenPrompt = (caseRunId: string): string => `Please attach the proof that resolves it — your ${intakeDocumentTypes.map((type) => documentLabels[type]).join(', ')}, plus any authority document that applies (PDF, Word or image files). I'll reopen ${caseRunId} as a new version for reassessment. To leave it closed, choose "Cancel request".`;
const proofRequestView = (): NonNullable<ChatReply['evidenceRequest']> => ({ evidenceRequestId: '', evidenceChannel: 'CHAT', requestedItems: intakeDocumentTypes.map((type) => documentLabels[type]), status: 'OPEN', attemptCount: 0, maxAttempts: 3 });

const statusItems = (items: string[]): string => items.map((item) => `- ${item}`).join('\n');
const inProgressFooter = '\n\n*Synthetic prototype. No production-system update or customer communication has been performed.*';

/** The customer already has a case: say where it stands instead of opening a duplicate (and offer to resume or reopen it where that makes sense). */
async function presentPriorCase(deps: ChatDependencies, sessionId: string, name: string, prior: PriorCase, requestTypeId: string, requestReply: { requestType?: NonNullable<ChatReply['requestType']> }): Promise<ChatReply> {
  const { repository } = deps;
  const ref = prior.caseRecord.caseRunId;
  const company = prior.caseRecord.businessName;
  const done = async (message: string): Promise<ChatReply> => {
    await repository.saveSession(session(sessionId, ref, 'DONE'));
    return { sessionId, step: 'DONE', messages: [message + inProgressFooter], caseRunId: ref, ...requestReply, syntheticDataDisclaimer: true };
  };
  switch (prior.kind) {
    case 'DOCUMENTS': {
      // Same case, same open document request: the customer carries on right here, in this conversation.
      await repository.saveSession(session(sessionId, ref, 'AWAITING_EVIDENCE', prior.request.evidenceRequestId, emptyIntake, requestTypeId));
      const left = prior.request.maxAttempts - prior.request.attemptCount;
      const gaps = assessDocuments(prior.request, await repository.getEvidence(prior.request.evidenceRequestId)).remainingGaps.map((gap) => gap.replace(/ is still needed\.$/, ''));
      return { sessionId, step: 'AWAITING_EVIDENCE', messages: [`Welcome back ${name}. Your request **${ref}** for **${company}** is **already in progress** — I'm still waiting for these documents:\n\n${statusItems(gaps.length > 0 ? gaps : prior.request.requestedItems)}\n\nAttach them here and I'll carry on from where we left off (${left} attempt${left === 1 ? '' : 's'} left). ${attachHint}`], caseRunId: ref, evidenceRequest: requestView(prior.request), ...requestReply, syntheticDataDisclaimer: true };
    }
    case 'SPECIALIST':
      return done(`Welcome back ${name}. Your request **${ref}** for **${company}** is **already in progress**: our checks are complete and a specialist is reviewing it.\n\nThere is nothing more you need to send right now, and I have not opened a new case. You will be contacted once a decision is confirmed.`);
    case 'LEAD':
      return done(`Welcome back ${name}. **${company}** is **already registered as new lead case ${ref}**, and **onboarding status is Pending**.\n\nA representative from our onboarding team will get back to you — there is no need to submit it again.`);
    case 'APPROVED':
      return done(`Welcome back ${name}. Your request **${ref}** for **${company}** has **already been approved**, so there is nothing more to submit and I have not opened a new case.`);
    case 'CLOSED': {
      // Closed (by a reviewer, or because the document request was cancelled): ask before doing anything.
      await repository.saveSession(session(sessionId, ref, 'CONFIRM_REOPEN', '', emptyIntake, requestTypeId));
      const why = prior.how === 'DECISION' ? customerReason(prior.reasonCode) : '';
      const closedHow = prior.how === 'DECISION' ? 'reviewed and closed without approval' : 'closed when the document request was cancelled';
      const proof = prior.how === 'DECISION' ? 'the correct proof' : 'the documents';
      return { sessionId, step: 'INTAKE', messages: [`Welcome back ${name}. Your earlier request **${ref}** for **${company}** was ${closedHow}.${why ? `\n\n${why}` : ''}\n\nWould you like to **reopen** it so you can submit ${proof}? Reply **yes** to reopen it, or **no** to leave it closed.`], caseRunId: ref, ...requestReply, syntheticDataDisclaimer: true };
    }
  }
}

/** Full name and company are known. An existing case is reported (or resumed / offered for reopening) instead of duplicated; a company that is not on record asks for confirmation before a lead is created. */
async function proceed(deps: ChatDependencies, sessionId: string, details: IntakeDetails, chosen: RequestType | undefined, requestTypeId: string, requestReply: { requestType?: NonNullable<ChatReply['requestType']> }): Promise<ChatReply> {
  const { repository } = deps;
  const known = findKnownBusiness(details.businessName);
  if (!chosen || chosen.automated) {
    const prior = await findPriorCase(repository, details.representativeName, known?.businessName ?? details.businessName);
    if (prior) return presentPriorCase(deps, sessionId, details.representativeName, prior, requestTypeId, requestReply);
  }
  if (!known) {
    const candidates = suggestKnownBusinesses(details.businessName);
    if (candidates.length) {
      await repository.saveSession(session(sessionId, '', 'CONFIRM_COMPANY', '', { ...details, suggestedBusiness: candidates.join('|') }, requestTypeId));
      return { sessionId, step: 'INTAKE', messages: [didYouMeanMessage(details.businessName, candidates)], caseRunId: '', ...requestReply, syntheticDataDisclaimer: true };
    }
    await repository.saveSession(session(sessionId, '', 'CONFIRM_LEAD', '', details, requestTypeId));
    return { sessionId, step: 'INTAKE', messages: [confirmLeadMessage(details.businessName)], caseRunId: '', ...requestReply, syntheticDataDisclaimer: true };
  }
  const opened = await openIntakeCase(repository, details, requestTypeId);
  const { caseRecord } = opened;
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

/** The customer confirmed the company name: record the lead with onboarding status PENDING and tell them a representative will get back. */
async function createLead(deps: ChatDependencies, sessionId: string, details: IntakeDetails, requestTypeId: string, requestReply: { requestType?: NonNullable<ChatReply['requestType']> }): Promise<ChatReply> {
  const { caseRecord } = await openIntakeCase(deps.repository, details, requestTypeId);
  await captureNewLead(deps.repository, caseRecord, sessionId);
  await deps.repository.saveSession(session(sessionId, caseRecord.caseRunId, 'DONE'));
  return { sessionId, step: 'DONE', messages: [`Thanks ${caseRecord.representativeName}. I've registered **${caseRecord.businessName}** as **new lead case ${caseRecord.caseRunId}**.\n\nA representative from our onboarding team will get back to you to onboard the business. **Onboarding status: Pending.**\n\nNo checks have been run and nothing has been approved: your details stay unverified until onboarding is complete.\n\n*Synthetic prototype. No production-system update or customer communication has been performed.*`], caseRunId: caseRecord.caseRunId, ...requestReply, syntheticDataDisclaimer: true };
}
