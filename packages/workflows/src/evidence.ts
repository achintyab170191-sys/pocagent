/**
 * Evidence loop of the To-Be process. Evidence is DOCUMENTS ONLY (Emirates ID, Trade License, Establishment Card, POA/MOA): free text is never
 * accepted as evidence. A document is classified and its fields are read by deterministic code; its content is data, never instructions.
 *
 *   evidence request (SBO.01 asks / SBO.02 asks for a missing document)
 *     → documents attached in the chat          (submitDocumentEvidence)
 *     → completeness check of the request       (resolveEvidence: RESOLVED | INSUFFICIENT)
 *     → RESOLVED: the originating check is re-run against the new documents and the assessment resumes from it
 *       INSUFFICIENT: the missing documents are named and the same request stays open; the third failed attempt goes to a human reviewer.
 */
import { type AgentRuntime } from '@sbo/agent-runtime';
import { type Evidence, type EvidenceRequest, type HumanReview, type DocumentType, SourceAuditEvents, classifyDocument, documentLabels, mandatoryCheckTypes, requiredDocumentTypes } from '@sbo/domain';
import { type Repository, now, uniqueMillis } from '@sbo/persistence';
import { resumeAssessment, type AssessmentResult } from './super-agent.js';

const uploadStatuses = new Set(['OPEN', 'PARTIALLY_RECEIVED', 'INSUFFICIENT']);
const resolutionStatuses = new Set(['RECEIVED', 'PARTIALLY_RECEIVED', 'INSUFFICIENT']);
/**
 * Canonical MIME types accepted as evidence. Text is extracted server-side (PDF text layer, Word body text, image OCR).
 */
export const evidenceMimeTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp'] as const;
export const cancelWords = ['CANCEL', 'STOP', 'END', 'CANCEL REQUEST'];

// ---------------------------------------------------------------------------------------------------------------
// Validation and receiving documents
// ---------------------------------------------------------------------------------------------------------------

export interface UploadValidation { uploadAllowed: boolean; rejectionReason: string; caseRunId: string; request?: EvidenceRequest; }

/** The stored evidence-request row is authoritative for case identity. */
export function validateEvidenceRequest(request: EvidenceRequest | undefined, submittedRequestId: string, suppliedCaseRunId = '', options: { allowReceived?: boolean } = {}): UploadValidation {
  const requestFound = Boolean(request?.evidenceRequestId.trim());
  const requestIdMatches = requestFound && request?.evidenceRequestId === submittedRequestId.trim();
  const stored = request?.caseRunId.trim() ?? '';
  const supplied = suppliedCaseRunId.trim();
  const caseMismatch = Boolean(supplied && stored && supplied !== stored);
  const effective = stored || supplied;
  // `allowReceived` (chat path): a request still RECEIVED means an earlier answer has not been assessed yet, so the customer may add to it.
  const statusPermitted = uploadStatuses.has(request?.status ?? '') || (options.allowReceived === true && request?.status === 'RECEIVED');
  let rejectionReason = '';
  if (!submittedRequestId.trim()) rejectionReason = 'EVIDENCE_REQUEST_ID_NOT_SUPPLIED';
  else if (!requestFound) rejectionReason = 'EVIDENCE_REQUEST_NOT_FOUND';
  else if (!requestIdMatches) rejectionReason = 'EVIDENCE_REQUEST_ID_MISMATCH';
  else if (!effective) rejectionReason = 'CASE_RUN_ID_NOT_AVAILABLE';
  else if (caseMismatch) rejectionReason = 'CASE_RUN_ID_MISMATCH';
  else if (!statusPermitted) rejectionReason = 'EVIDENCE_REQUEST_NOT_OPEN';
  return { uploadAllowed: rejectionReason === '', rejectionReason, caseRunId: effective, request };
}

export interface UploadInput { caseRunId?: string; fileName: string; mimeType: string; storageUrl: string; extractedText: string; allowReceived?: boolean; }

/** What kind of document is this text? Throws DOCUMENT_TEXT_UNAVAILABLE (< 20 characters) or DOCUMENT_TYPE_NOT_RECOGNISED (nothing is stored). */
export function readEvidenceDocument(extractedText: string): { documentType: DocumentType; fields: Record<string, unknown>; text: string } {
  const text = extractedText.trim();
  if (text.length < 20) throw new Error('DOCUMENT_TEXT_UNAVAILABLE');
  const classified = classifyDocument(text);
  if (!classified) throw new Error('DOCUMENT_TYPE_NOT_RECOGNISED');
  return { documentType: classified.documentType, fields: classified.fields, text };
}

export async function submitDocumentEvidence(repository: Repository, evidenceRequestId: string, input: UploadInput): Promise<Evidence> {
  const request = await repository.getEvidenceRequest(evidenceRequestId);
  const validation = validateEvidenceRequest(request, evidenceRequestId, input.caseRunId, { allowReceived: input.allowReceived });
  if (!validation.uploadAllowed || !request) throw new Error(validation.rejectionReason);
  if (!(evidenceMimeTypes as readonly string[]).includes(input.mimeType)) throw new Error('UNSUPPORTED_FILE_TYPE');
  const document = readEvidenceDocument(input.extractedText);
  const evidence: Evidence = { evidenceId: `EVIDENCE-${request.caseRunId}-${uniqueMillis()}`, evidenceRequestId, caseRunId: request.caseRunId, submissionVersion: request.submissionVersion, evidenceType: document.documentType, evidenceSource: 'FILE_UPLOAD', fileName: input.fileName, mimeType: input.mimeType, storageUrl: input.storageUrl, evidenceText: document.text, structuredData: { document_type: document.documentType, fields: document.fields, extracted_character_count: document.text.length }, validationStatus: 'RECEIVED', confidence: 0, providedAt: now(), superseded: false };
  await repository.transaction(async (transaction) => {
    await transaction.persistEvidence(evidence);
    await transaction.persistEvidenceRequest({ ...request, status: 'RECEIVED', receivedAt: now() });
    await transaction.appendAudit({ eventId: `EVT-${request.caseRunId}-FILE-EVIDENCE-${uniqueMillis()}`, caseRunId: request.caseRunId, submissionVersion: request.submissionVersion, timestamp: now(), actor: 'CUSTOMER_SYNTHETIC', eventType: SourceAuditEvents.ADDITIONAL_EVIDENCE_RECEIVED, stage: 'EVIDENCE_COLLECTION', previousState: 'WAITING_FOR_EVIDENCE', newState: 'EVIDENCE_RECEIVED', ruleId: '', reasonCode: 'CUSTOMER_DOCUMENT_RECEIVED', evidenceReference: evidence.evidenceId, details: { fileName: input.fileName, documentType: document.documentType, evidenceId: evidence.evidenceId } });
  });
  return evidence;
}

// ---------------------------------------------------------------------------------------------------------------
// Resolution (deterministic completeness check)
// ---------------------------------------------------------------------------------------------------------------

export interface EvidenceResolution { resolutionStatus: 'RESOLVED' | 'INSUFFICIENT'; supportedFacts: string[]; remainingGaps: string[]; }
export interface MaterializedResolution { nextRequest: EvidenceRequest; retryAllowed: boolean; escalationRequired: boolean; resolution: EvidenceResolution; resolutionStatus: EvidenceResolution['resolutionStatus']; }

export function assessDocuments(request: EvidenceRequest, evidence: Evidence[]): EvidenceResolution {
  const present = new Set(evidence.map((record) => String(record.structuredData.document_type ?? record.evidenceType)));
  const required = requiredDocumentTypes(request.originatingCheckType);
  const missing = required.filter((type) => !present.has(type));
  return {
    resolutionStatus: missing.length === 0 ? 'RESOLVED' : 'INSUFFICIENT',
    supportedFacts: required.filter((type) => present.has(type)).map((type) => `${documentLabels[type]} received.`),
    remainingGaps: missing.map((type) => `${documentLabels[type]} is still needed.`),
  };
}

export function materializeResolution(request: EvidenceRequest, resolution: EvidenceResolution): MaterializedResolution {
  const attemptCount = request.attemptCount + 1;
  const timestamp = now();
  if (resolution.resolutionStatus === 'RESOLVED') return { resolution, resolutionStatus: 'RESOLVED', retryAllowed: false, escalationRequired: false, nextRequest: { ...request, status: 'ACCEPTED', attemptCount, receivedAt: request.receivedAt ?? timestamp, resolvedAt: timestamp } };
  const retryAllowed = attemptCount < request.maxAttempts;
  return { resolution, resolutionStatus: 'INSUFFICIENT', retryAllowed, escalationRequired: !retryAllowed, nextRequest: { ...request, status: retryAllowed ? 'INSUFFICIENT' : 'ESCALATED', attemptCount, receivedAt: request.receivedAt ?? timestamp, resolvedAt: retryAllowed ? undefined : timestamp } };
}

export interface EvidenceResolutionResult extends MaterializedResolution { request: EvidenceRequest; }

/** Removes one check's persisted result so the next assessment re-runs exactly that check against the new documents (3-part key). */
export async function dropRuntimeResult(repository: Repository, caseRunId: string, submissionVersion: number, checkType: string): Promise<void> {
  const rows = await repository.getRuntimeResults(caseRunId, submissionVersion);
  if (!rows.some((row) => row.checkType.toUpperCase() === checkType.toUpperCase())) return;
  await repository.deleteRuntimeResults(caseRunId, submissionVersion);
  for (const row of rows) if (row.checkType.toUpperCase() !== checkType.toUpperCase()) await repository.upsertUtilityResult(row);
}

/**
 * One atomic step: the request row is read under a lock and every write commits together, so two parallel calls cannot both spend the same
 * attempt or resume the assessment twice.
 */
export async function resolveEvidence(repository: Repository, evidenceRequestId: string, caseRunId: string, submissionVersion: number): Promise<EvidenceResolutionResult> {
  return repository.transaction((transaction) => resolveEvidenceLocked(transaction, evidenceRequestId, caseRunId, submissionVersion));
}

async function resolveEvidenceLocked(repository: Repository, evidenceRequestId: string, caseRunId: string, submissionVersion: number): Promise<EvidenceResolutionResult> {
  const request = await repository.getEvidenceRequest(evidenceRequestId);
  if (!request) throw new Error('EVIDENCE_REQUEST_NOT_FOUND');
  if (request.caseRunId !== caseRunId.trim()) throw new Error('CASE_RUN_ID_MISMATCH');
  if (request.submissionVersion !== Number(submissionVersion)) throw new Error('SUBMISSION_VERSION_MISMATCH');
  if (!resolutionStatuses.has(request.status)) throw new Error('EVIDENCE_REQUEST_NOT_READY_FOR_RESOLUTION');
  const evidence = (await repository.getEvidence(evidenceRequestId)).filter((record) => !['REJECTED', 'SUPERSEDED'].includes(record.validationStatus));
  if (evidence.length === 0) throw new Error('EVIDENCE_RECORDS_NOT_FOUND');
  // Never spend a customer attempt without a newly received document.
  if (!evidence.some((record) => record.validationStatus === 'RECEIVED')) throw new Error('NO_NEW_EVIDENCE_RECEIVED');
  const resolution = assessDocuments(request, evidence);
  const materialized = materializeResolution(request, resolution);
  await repository.transaction(async (transaction) => {
    const recordStatus = resolution.resolutionStatus === 'RESOLVED' ? 'ACCEPTED' : 'INSUFFICIENT';
    for (const record of evidence) if (record.validationStatus === 'RECEIVED') await transaction.persistEvidence({ ...record, validationStatus: recordStatus });
    await transaction.persistEvidenceRequest(materialized.nextRequest);
    // Accepted documents for a failed check: that check is re-run against them (the assessment resumes from it).
    if (resolution.resolutionStatus === 'RESOLVED' && (mandatoryCheckTypes as readonly string[]).includes(request.originatingCheckType.toUpperCase())) await dropRuntimeResult(transaction, caseRunId, request.submissionVersion, request.originatingCheckType);
    await transaction.appendAudit({ eventId: `EVT-${caseRunId}-EVIDENCE-RESOLUTION-${uniqueMillis()}`, caseRunId, submissionVersion: request.submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: SourceAuditEvents.ADDITIONAL_EVIDENCE_REQUIRED, stage: 'EVIDENCE_RESOLUTION', previousState: request.status || 'RECEIVED', newState: materialized.nextRequest.status, ruleId: resolution.resolutionStatus === 'RESOLVED' ? '' : 'EVID-002', reasonCode: resolution.resolutionStatus === 'RESOLVED' ? 'ADDITIONAL_EVIDENCE_ACCEPTED' : 'ADDITIONAL_EVIDENCE_INSUFFICIENT', evidenceReference: evidence.map((record) => record.evidenceId).join('; '), details: { resolutionStatus: resolution.resolutionStatus, attemptCount: materialized.nextRequest.attemptCount, maxAttempts: request.maxAttempts, retryAllowed: materialized.retryAllowed, escalationRequired: materialized.escalationRequired, remainingGaps: resolution.remainingGaps } });
  });
  return { ...materialized, request: materialized.nextRequest };
}

// ---------------------------------------------------------------------------------------------------------------
// Routing after resolution
// ---------------------------------------------------------------------------------------------------------------

export type EvidenceRoute = 'RESUMED' | 'RETRY' | 'ESCALATED_MAX_ATTEMPTS';
export interface EvidenceContinuation { route: EvidenceRoute; resolution: EvidenceResolutionResult; resumedAssessment?: AssessmentResult; review?: HumanReview; remainingGaps: string[]; }

async function escalateToEvidenceReview(repository: Repository, resolved: EvidenceResolutionResult): Promise<HumanReview> {
  const request = resolved.request;
  return repository.transaction(async (transaction) => {
    const baseId = `REV-${request.caseRunId}-EVIDENCE-${request.submissionVersion}`;
    let reviewId = baseId;
    for (let suffix = 2; (await transaction.getReview(reviewId))?.reviewStatus.toUpperCase() === 'COMPLETED'; suffix += 1) reviewId = `${baseId}-${suffix}`;
    const review: HumanReview = { reviewId, caseRunId: request.caseRunId, reviewQueue: 'EVIDENCE_REVIEW', agentRecommendation: 'NEED_MORE_INFORMATION', reviewerName: '', reviewerDecision: '', reviewerComments: '', overrideReason: '', reviewStatus: 'PENDING', requestedAt: now(), completedAt: '' };
    await transaction.persistReview(review);
    const runtimeCase = await transaction.getRuntimeCase(request.caseRunId);
    if (runtimeCase) await transaction.persistRuntimeCase({ ...runtimeCase, status: 'REVIEW_PENDING', currentStage: 'HUMAN_REVIEW', targetQueue: 'EVIDENCE_REVIEW', humanReviewRequired: true, updatedAt: now() });
    await transaction.appendAudit({ eventId: `EVT-${request.caseRunId}-EVIDENCE-ESCALATION-${uniqueMillis()}`, caseRunId: request.caseRunId, submissionVersion: request.submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: SourceAuditEvents.EVIDENCE_REVIEW_QUEUED, stage: 'EVIDENCE_RESOLUTION', previousState: 'INSUFFICIENT', newState: 'REVIEW_PENDING', ruleId: 'EVID-002', reasonCode: 'MAX_EVIDENCE_ATTEMPTS_EXHAUSTED', evidenceReference: request.evidenceRequestId, details: { reviewId: review.reviewId, resolutionStatus: resolved.resolutionStatus } });
    return review;
  });
}

/** Resolve + route: RESOLVED resumes the assessment, INSUFFICIENT re-asks, the third insufficient attempt goes to a human reviewer. */
export async function resolveEvidenceAndContinue(repository: Repository, agentRuntime: AgentRuntime, evidenceRequestId: string, caseRunId: string, submissionVersion: number, sessionId = ''): Promise<EvidenceContinuation> {
  const resolution = await resolveEvidence(repository, evidenceRequestId, caseRunId, submissionVersion);
  const remainingGaps = resolution.resolution.remainingGaps;
  if (resolution.resolutionStatus === 'RESOLVED') return { route: 'RESUMED', resolution, remainingGaps, resumedAssessment: await resumeAssessment(repository, agentRuntime, caseRunId, sessionId) };
  if (resolution.retryAllowed) return { route: 'RETRY', resolution, remainingGaps };
  return { route: 'ESCALATED_MAX_ATTEMPTS', resolution, remainingGaps, review: await escalateToEvidenceReview(repository, resolution) };
}

// ---------------------------------------------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------------------------------------------

export async function cancelEvidenceRequest(repository: Repository, evidenceRequestId: string, suppliedCaseRunId?: string): Promise<EvidenceRequest> {
  return repository.transaction(async (transaction) => {
    const request = await transaction.getEvidenceRequest(evidenceRequestId);
    if (!request) throw new Error('EVIDENCE_REQUEST_NOT_FOUND');
    if (suppliedCaseRunId && suppliedCaseRunId !== request.caseRunId) throw new Error('CASE_RUN_ID_MISMATCH');
    if (!['OPEN', 'RECEIVED', 'PARTIALLY_RECEIVED', 'INSUFFICIENT'].includes(request.status)) throw new Error('EVIDENCE_REQUEST_NOT_OPEN');
    const cancelled: EvidenceRequest = { ...request, status: 'CANCELLED', resolvedAt: now() };
    await transaction.persistEvidenceRequest(cancelled);
    const runtimeCase = await transaction.getRuntimeCase(request.caseRunId);
    if (runtimeCase) await transaction.persistRuntimeCase({ ...runtimeCase, status: 'EVIDENCE_REQUEST_CANCELLED', currentStage: 'CUSTOMER_EVIDENCE', targetQueue: 'CUSTOMER_FOLLOW_UP', humanReviewRequired: false, updatedAt: now() });
    await transaction.appendAudit({ eventId: `EVT-${request.caseRunId}-EVIDENCE-CANCELLED-${uniqueMillis()}`, caseRunId: request.caseRunId, submissionVersion: request.submissionVersion, timestamp: now(), actor: 'CUSTOMER_SYNTHETIC', eventType: SourceAuditEvents.EVIDENCE_REQUEST_CANCELLED, stage: 'EVIDENCE_COLLECTION', previousState: 'WAITING_FOR_EVIDENCE', newState: 'EVIDENCE_REQUEST_CANCELLED', ruleId: '', reasonCode: 'CUSTOMER_CANCELLED_EVIDENCE_REQUEST', evidenceReference: request.evidenceRequestId, details: { previousRequestStatus: request.status } });
    return cancelled;
  });
}
