/**
 * Workflow 96 (Customer Evidence Upload Portal), Workflow 95 (Evidence Resolution Utility) and the post-resolution
 * routing that lives in Workflow 03 (resume / retry / max-attempt escalation / contradictory escalation).
 */
import { type AgentRuntime } from '@sbo/agent-runtime';
import { type Evidence, EvidenceResolutionSchema, type EvidenceResolution, type EvidenceRequest, type HumanReview, type UtilityResult, SourceAuditEvents } from '@sbo/domain';
import { type Repository, now, uniqueMillis } from '@sbo/persistence';
import { resumeAssessment, type AssessmentResult } from './super-agent.js';

const uploadStatuses = new Set(['OPEN', 'PARTIALLY_RECEIVED', 'INSUFFICIENT']);
const resolutionStatuses = new Set(['RECEIVED', 'PARTIALLY_RECEIVED', 'INSUFFICIENT']);
const sequenceByCheck: Record<string, number> = { REQUEST_CLARIFICATION: 0, CUSTOMER_CONFIRMATION: 0, SALES_CONFIRMATION: 0, DOCUMENT_EXTRACTION: 1, BUSINESS_VALIDATION: 2, IDENTITY_VALIDATION: 3, AUTHORITY_VALIDATION: 4, SYSTEM_DATA_CHECK: 5, FINANCIAL_CHECK: 6, FINAL_VERIFICATION: 7 };
const evidenceTypeByCheck: Record<string, string> = { DOCUMENT_EXTRACTION: 'DOCUMENT_CLARIFICATION', BUSINESS_VALIDATION: 'BUSINESS_CLARIFICATION', IDENTITY_VALIDATION: 'IDENTITY_CLARIFICATION', AUTHORITY_VALIDATION: 'AUTHORITY_CLARIFICATION', SYSTEM_DATA_CHECK: 'SYSTEM_DATA_CLARIFICATION', FINANCIAL_CHECK: 'FINANCIAL_CLARIFICATION', REQUEST_CLARIFICATION: 'CUSTOMER_CLARIFICATION', CUSTOMER_CONFIRMATION: 'CUSTOMER_CONFIRMATION', SALES_CONFIRMATION: 'SALES_CONFIRMATION' };
export const uploadEvidenceTypes = ['AUTHORITY_DOCUMENT', 'IDENTITY_DOCUMENT', 'BUSINESS_DOCUMENT', 'ADDRESS_PROOF', 'CUSTOMER_CONFIRMATION', 'OTHER'] as const;
export const cancelWords = ['CANCEL', 'STOP', 'END', 'CANCEL REQUEST'];

// ---------------------------------------------------------------------------------------------------------------
// Workflow 96 — "Validate Evidence Request"
// ---------------------------------------------------------------------------------------------------------------

export interface UploadValidation { uploadAllowed: boolean; rejectionReason: string; caseRunId: string; request?: EvidenceRequest; }

/** The stored evidence-request row is authoritative for case identity. */
export function validateEvidenceRequest(request: EvidenceRequest | undefined, submittedRequestId: string, suppliedCaseRunId = ''): UploadValidation {
  const requestFound = Boolean(request?.evidenceRequestId.trim());
  const requestIdMatches = requestFound && request?.evidenceRequestId === submittedRequestId.trim();
  const stored = request?.caseRunId.trim() ?? '';
  const supplied = suppliedCaseRunId.trim();
  const caseMismatch = Boolean(supplied && stored && supplied !== stored);
  const effective = stored || supplied;
  const statusPermitted = uploadStatuses.has(request?.status ?? '');
  let rejectionReason = '';
  if (!submittedRequestId.trim()) rejectionReason = 'EVIDENCE_REQUEST_ID_NOT_SUPPLIED';
  else if (!requestFound) rejectionReason = 'EVIDENCE_REQUEST_NOT_FOUND';
  else if (!requestIdMatches) rejectionReason = 'EVIDENCE_REQUEST_ID_MISMATCH';
  else if (!effective) rejectionReason = 'CASE_RUN_ID_NOT_AVAILABLE';
  else if (caseMismatch) rejectionReason = 'CASE_RUN_ID_MISMATCH';
  else if (!statusPermitted) rejectionReason = 'EVIDENCE_REQUEST_NOT_OPEN';
  return { uploadAllowed: rejectionReason === '', rejectionReason, caseRunId: effective, request };
}

async function receiveEvidence(repository: Repository, request: EvidenceRequest, evidence: Evidence, reasonCode: string, detail: Record<string, unknown>): Promise<void> {
  await repository.transaction(async (transaction) => {
    await transaction.persistEvidence(evidence);
    // Request and evidence are RECEIVED before evidence resolution begins.
    await transaction.persistEvidenceRequest({ ...request, status: 'RECEIVED', receivedAt: now() });
    await transaction.appendAudit({ eventId: `EVT-${request.caseRunId}-${reasonCode === 'CUSTOMER_TEXT_EVIDENCE_RECEIVED' ? 'EVIDENCE-RECEIVED' : 'FILE-EVIDENCE'}-${uniqueMillis()}`, caseRunId: request.caseRunId, submissionVersion: request.submissionVersion, timestamp: now(), actor: 'CUSTOMER_SYNTHETIC', eventType: SourceAuditEvents.ADDITIONAL_EVIDENCE_RECEIVED, stage: 'EVIDENCE_COLLECTION', previousState: 'WAITING_FOR_EVIDENCE', newState: 'EVIDENCE_RECEIVED', ruleId: '', reasonCode, evidenceReference: evidence.evidenceId, details: { ...detail, evidenceId: evidence.evidenceId, evidenceType: evidence.evidenceType, evidenceSource: evidence.evidenceSource } });
  });
}

export async function submitTextEvidence(repository: Repository, evidenceRequestId: string, input: { caseRunId?: string; text: string }): Promise<Evidence> {
  const request = await repository.getEvidenceRequest(evidenceRequestId);
  const validation = validateEvidenceRequest(request, evidenceRequestId, input.caseRunId);
  if (!validation.uploadAllowed || !request) throw new Error(validation.rejectionReason);
  const text = input.text.trim();
  if (!text) throw new Error('EVIDENCE_TEXT_EMPTY');
  const evidence: Evidence = { evidenceId: `EVIDENCE-${request.caseRunId}-${uniqueMillis()}`, evidenceRequestId, caseRunId: request.caseRunId, submissionVersion: request.submissionVersion, evidenceType: evidenceTypeByCheck[request.originatingCheckType.toUpperCase()] ?? 'CUSTOMER_CLARIFICATION', evidenceSource: 'CHAT_TEXT', fileName: '', mimeType: 'text/plain', storageUrl: '', evidenceText: text, structuredData: { originating_check_type: request.originatingCheckType }, validationStatus: 'RECEIVED', confidence: 0, providedAt: now(), superseded: false };
  await receiveEvidence(repository, request, evidence, 'CUSTOMER_TEXT_EVIDENCE_RECEIVED', {});
  return evidence;
}

export interface UploadInput { caseRunId?: string; evidenceType?: string; notes?: string; fileName: string; mimeType: string; storageUrl: string; extractedText: string; }

/** PDF text extraction happens in the API layer; this function applies the source's "PDF Text Available?" gate (≥ 20 characters). */
export async function submitUploadedEvidence(repository: Repository, evidenceRequestId: string, input: UploadInput): Promise<Evidence> {
  const request = await repository.getEvidenceRequest(evidenceRequestId);
  const validation = validateEvidenceRequest(request, evidenceRequestId, input.caseRunId);
  if (!validation.uploadAllowed || !request) throw new Error(validation.rejectionReason);
  if (input.mimeType !== 'application/pdf') throw new Error('UNSUPPORTED_FILE_TYPE');
  const text = input.extractedText.trim();
  if (text.length < 20) throw new Error('PDF_TEXT_UNAVAILABLE');
  const evidenceType = (uploadEvidenceTypes as readonly string[]).includes(input.evidenceType ?? '') ? input.evidenceType! : 'OTHER';
  const evidence: Evidence = { evidenceId: `EVIDENCE-${request.caseRunId}-${uniqueMillis()}`, evidenceRequestId, caseRunId: request.caseRunId, submissionVersion: request.submissionVersion, evidenceType, evidenceSource: 'FILE_UPLOAD', fileName: input.fileName, mimeType: input.mimeType, storageUrl: input.storageUrl, evidenceText: text, structuredData: { evidence_notes: input.notes ?? '', extracted_character_count: text.length }, validationStatus: 'RECEIVED', confidence: 0, providedAt: now(), superseded: false };
  await receiveEvidence(repository, request, evidence, 'CUSTOMER_FILE_EVIDENCE_RECEIVED', { fileName: input.fileName });
  return evidence;
}

// ---------------------------------------------------------------------------------------------------------------
// Workflow 95 — Evidence Resolution Utility
// ---------------------------------------------------------------------------------------------------------------

export interface MaterializedResolution { result: UtilityResult; nextRequest: EvidenceRequest; retryAllowed: boolean; escalationRequired: boolean; resolutionStatus: EvidenceResolution['resolutionStatus']; }

/** "Build Resolved Utility Result" */
export function materializeResolution(request: EvidenceRequest, evidence: Evidence[], resolution: EvidenceResolution): MaterializedResolution {
  const attemptCount = request.attemptCount + 1;
  const checkType = (request.originatingCheckType || 'REQUEST_CLARIFICATION').trim().toUpperCase();
  const references = evidence.map((record) => record.evidenceId);
  const base = {
    resultId: `RES-${request.caseRunId}-V${request.submissionVersion}-${checkType}`, caseRunId: request.caseRunId, submissionVersion: request.submissionVersion, sequence: sequenceByCheck[checkType] ?? 0, agentId: 'SBO.02', utilityName: 'Evidence Resolution Utility', checkType,
    findings: { evidence_resolution: true, evidence_request_id: request.evidenceRequestId, resolution_status: resolution.resolutionStatus, resolved: resolution.resolutionStatus === 'RESOLVED', supported_facts: resolution.supportedFacts, remaining_gaps: resolution.remainingGaps, evidence_count: references.length },
    evidenceReferences: references, confidence: Math.max(0, Math.min(1, resolution.confidence)), ruleStatusUsed: 'CONFIRMED_POC', prototypeData: true as const, superseded: false, createdAt: now(), evidenceRequestId: request.evidenceRequestId,
  };
  const timestamp = now();
  if (resolution.resolutionStatus === 'RESOLVED') {
    return { resolutionStatus: 'RESOLVED', retryAllowed: false, escalationRequired: false, result: { ...base, status: 'PASS', reasonCodes: [...new Set(['ADDITIONAL_EVIDENCE_ACCEPTED', ...resolution.reasonCodes])], humanReviewRequired: false, recommendedNextStep: resolution.recommendedNextAction || 'Resume processing from the next incomplete mandatory check.', ruleIds: ['EVID-001'], isTerminal: false, terminalOutcome: '' }, nextRequest: { ...request, status: 'ACCEPTED', attemptCount, receivedAt: request.receivedAt ?? timestamp, resolvedAt: timestamp } };
  }
  if (resolution.resolutionStatus === 'CONTRADICTORY') {
    return { resolutionStatus: 'CONTRADICTORY', retryAllowed: false, escalationRequired: true, result: { ...base, status: 'INCONCLUSIVE', reasonCodes: [...new Set(['ADDITIONAL_EVIDENCE_CONTRADICTORY', ...resolution.reasonCodes])], humanReviewRequired: true, recommendedNextStep: resolution.recommendedNextAction || 'Route the case and conflicting evidence to human evidence review.', ruleIds: ['EVID-003'], isTerminal: true, terminalOutcome: 'MANUAL_REVIEW' }, nextRequest: { ...request, status: 'ESCALATED', attemptCount, receivedAt: request.receivedAt ?? timestamp, resolvedAt: timestamp } };
  }
  const retryAllowed = attemptCount < request.maxAttempts;
  return { resolutionStatus: resolution.resolutionStatus, retryAllowed, escalationRequired: !retryAllowed, result: { ...base, status: 'INCONCLUSIVE', reasonCodes: [...new Set(['ADDITIONAL_EVIDENCE_INSUFFICIENT', ...resolution.reasonCodes])], humanReviewRequired: false, recommendedNextStep: resolution.recommendedNextAction || (retryAllowed ? 'Request the specific remaining evidence and keep the case open.' : 'Route the unresolved evidence request to a human evidence reviewer.'), ruleIds: ['EVID-002'], isTerminal: true, terminalOutcome: 'NEED_MORE_INFORMATION' }, nextRequest: { ...request, status: retryAllowed ? 'INSUFFICIENT' : 'ESCALATED', attemptCount, receivedAt: request.receivedAt ?? timestamp, resolvedAt: retryAllowed ? undefined : timestamp } };
}

export interface EvidenceResolutionResult extends MaterializedResolution { request: EvidenceRequest; }

/**
 * Workflow 95 as one atomic step (security review SEC-03): the request row is read under a lock and every write commits together, so two
 * parallel /resolve calls cannot both spend the same attempt, call the model twice, or resume the assessment twice — the second sees the
 * updated request and is refused.
 */
export async function resolveEvidence(repository: Repository, agentRuntime: AgentRuntime, evidenceRequestId: string, caseRunId: string, submissionVersion: number): Promise<EvidenceResolutionResult> {
  return repository.transaction((transaction) => resolveEvidenceLocked(transaction, agentRuntime, evidenceRequestId, caseRunId, submissionVersion));
}

async function resolveEvidenceLocked(repository: Repository, agentRuntime: AgentRuntime, evidenceRequestId: string, caseRunId: string, submissionVersion: number): Promise<EvidenceResolutionResult> {
  // "Check Resolution Request"
  const request = await repository.getEvidenceRequest(evidenceRequestId);
  if (!request) throw new Error('EVIDENCE_REQUEST_NOT_FOUND');
  if (request.caseRunId !== caseRunId.trim()) throw new Error('CASE_RUN_ID_MISMATCH');
  if (request.submissionVersion !== Number(submissionVersion)) throw new Error('SUBMISSION_VERSION_MISMATCH');
  if (!resolutionStatuses.has(request.status)) throw new Error('EVIDENCE_REQUEST_NOT_READY_FOR_RESOLUTION');
  // "Check Evidence Records": active = not REJECTED / SUPERSEDED. Earlier INSUFFICIENT records stay in scope (cumulative evaluation).
  const evidence = (await repository.getEvidence(evidenceRequestId)).filter((record) => !['REJECTED', 'SUPERSEDED'].includes(record.validationStatus));
  if (evidence.length === 0) throw new Error('EVIDENCE_RECORDS_NOT_FOUND');
  // Target hardening (not in source): never spend a customer attempt without newly received evidence.
  if (!evidence.some((record) => record.validationStatus === 'RECEIVED')) throw new Error('NO_NEW_EVIDENCE_RECEIVED');
  const caseRecord = await repository.getCase(caseRunId);
  if (!caseRecord) throw new Error(`CASE_NOT_FOUND:${caseRunId}`);
  // The model output is validated BEFORE any write: malformed output is a system error and consumes no attempt.
  let resolution: EvidenceResolution;
  try {
    resolution = EvidenceResolutionSchema.parse(await agentRuntime.resolveEvidence({
      caseRunId, requestId: evidenceRequestId,
      evidenceRequest: { evidence_request_id: request.evidenceRequestId, case_run_id: request.caseRunId, submission_version: request.submissionVersion, originating_check_type: request.originatingCheckType, originating_reason_code: request.originatingReasonCode, evidence_channel: request.evidenceChannel, requested_items: request.requestedItems, attempt_count: request.attemptCount, max_attempts: request.maxAttempts },
      caseContext: { case_run_id: caseRecord.caseRunId, logical_case_id: caseRecord.caseId, country: caseRecord.country, request_type: caseRecord.requestType, business_name: caseRecord.businessName, business_identifier: caseRecord.businessIdentifier, customer_id: caseRecord.customerId, representative_name: caseRecord.representativeName, representative_role: caseRecord.representativeRole, requested_authority: caseRecord.requestedAuthority, request_narrative: caseRecord.requestNarrative },
      evidenceRecords: evidence.map((record) => ({ evidence_id: record.evidenceId, evidence_type: record.evidenceType, evidence_source: record.evidenceSource, file_name: record.fileName, mime_type: record.mimeType, evidence_text: record.evidenceText, structured_data_json: JSON.stringify(record.structuredData), provided_at: record.providedAt })),
    }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EVIDENCE_RESOLUTION')) throw error;
    throw new Error(`EVIDENCE_RESOLUTION_OUTPUT_INVALID: ${error instanceof Error ? error.message : 'unparseable'}`);
  }
  const materialized = materializeResolution(request, evidence, resolution);
  await repository.transaction(async (transaction) => {
    await transaction.upsertUtilityResult(materialized.result); // replaces exactly the originating check's row (3-part key)
    const recordStatus = resolution.resolutionStatus === 'RESOLVED' ? 'ACCEPTED' : resolution.resolutionStatus === 'CONTRADICTORY' ? 'CONTRADICTORY' : 'INSUFFICIENT';
    for (const record of evidence) if (record.validationStatus === 'RECEIVED') await transaction.persistEvidence({ ...record, validationStatus: recordStatus, confidence: materialized.result.confidence });
    await transaction.persistEvidenceRequest(materialized.nextRequest);
    await transaction.appendAudit({ eventId: `EVT-${caseRunId}-EVIDENCE-RESOLUTION-${uniqueMillis()}`, caseRunId, submissionVersion: request.submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: SourceAuditEvents.ADDITIONAL_EVIDENCE_REQUIRED, stage: 'EVIDENCE_RESOLUTION', previousState: request.status || 'RECEIVED', newState: materialized.nextRequest.status, ruleId: materialized.result.ruleIds[0] ?? '', reasonCode: materialized.result.reasonCodes[0] ?? '', evidenceReference: materialized.result.evidenceReferences.join('; '), details: { resolutionStatus: resolution.resolutionStatus, attemptCount: materialized.nextRequest.attemptCount, maxAttempts: request.maxAttempts, retryAllowed: materialized.retryAllowed, escalationRequired: materialized.escalationRequired } });
  });
  return { ...materialized, request: materialized.nextRequest };
}

// ---------------------------------------------------------------------------------------------------------------
// Workflow 03 — routing after "Resolve Customer Evidence"
// ---------------------------------------------------------------------------------------------------------------

export type EvidenceRoute = 'RESUMED' | 'RETRY' | 'ESCALATED_MAX_ATTEMPTS' | 'ESCALATED_CONTRADICTORY';
export interface EvidenceContinuation { route: EvidenceRoute; resolution: EvidenceResolutionResult; resumedAssessment?: AssessmentResult; review?: HumanReview; remainingGaps: string[]; }

async function escalateToEvidenceReview(repository: Repository, resolved: EvidenceResolutionResult, recommendation: 'NEED_MORE_INFORMATION' | 'MANUAL_REVIEW'): Promise<HumanReview> {
  const request = resolved.request;
  return repository.transaction(async (transaction) => {
    // Source ID: REV-{case}-EVIDENCE-{version} (an upsert). Hardening (SEC-11): never reset a COMPLETED review back to PENDING — take a numbered ID instead.
    const baseId = `REV-${request.caseRunId}-EVIDENCE-${request.submissionVersion}`;
    let reviewId = baseId;
    for (let suffix = 2; (await transaction.getReview(reviewId))?.reviewStatus.toUpperCase() === 'COMPLETED'; suffix += 1) reviewId = `${baseId}-${suffix}`;
    const review: HumanReview = { reviewId, caseRunId: request.caseRunId, reviewQueue: 'EVIDENCE_REVIEW', agentRecommendation: recommendation, reviewerName: '', reviewerDecision: '', reviewerComments: '', overrideReason: '', reviewStatus: 'PENDING', requestedAt: now(), completedAt: '' };
    await transaction.persistReview(review);
    const runtimeCase = await transaction.getRuntimeCase(request.caseRunId);
    if (runtimeCase) await transaction.persistRuntimeCase({ ...runtimeCase, status: 'REVIEW_PENDING', currentStage: 'HUMAN_REVIEW', targetQueue: 'EVIDENCE_REVIEW', humanReviewRequired: true, updatedAt: now() });
    const contradictory = recommendation === 'MANUAL_REVIEW';
    await transaction.appendAudit({ eventId: `EVT-${request.caseRunId}-EVIDENCE-${contradictory ? 'CONTRADICTION' : 'ESCALATION'}-${uniqueMillis()}`, caseRunId: request.caseRunId, submissionVersion: request.submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: contradictory ? SourceAuditEvents.CONTRADICTORY_EVIDENCE_ESCALATED : SourceAuditEvents.EVIDENCE_REVIEW_QUEUED, stage: 'EVIDENCE_RESOLUTION', previousState: contradictory ? 'EVIDENCE_RECEIVED' : 'INSUFFICIENT', newState: 'REVIEW_PENDING', ruleId: contradictory ? 'EVID-003' : 'EVID-002', reasonCode: contradictory ? 'ADDITIONAL_EVIDENCE_CONTRADICTORY' : 'MAX_EVIDENCE_ATTEMPTS_EXHAUSTED', evidenceReference: contradictory ? resolved.result.evidenceReferences.join('; ') : request.evidenceRequestId, details: { reviewId: review.reviewId, resolutionStatus: resolved.resolutionStatus } });
    return review;
  });
}

/**
 * Resolve + route. NOTE (source defect, recorded in docs/07): the n8n "Route Evidence Resolution" switch compares against the misspelled
 * literal "CONTRADITORY", so a real CONTRADICTORY result matches no branch and the workflow silently ends. The target implements the
 * documented intent (Create Contradictory Evidence Review → Update Case → Audit → message), as the migration brief requires an EVID-003 path.
 */
export async function resolveEvidenceAndContinue(repository: Repository, agentRuntime: AgentRuntime, evidenceRequestId: string, caseRunId: string, submissionVersion: number, sessionId = ''): Promise<EvidenceContinuation> {
  const resolution = await resolveEvidence(repository, agentRuntime, evidenceRequestId, caseRunId, submissionVersion);
  const remainingGaps = Array.isArray(resolution.result.findings.remaining_gaps) ? resolution.result.findings.remaining_gaps as string[] : [];
  if (resolution.resolutionStatus === 'RESOLVED') return { route: 'RESUMED', resolution, remainingGaps, resumedAssessment: await resumeAssessment(repository, agentRuntime, caseRunId, sessionId) };
  if (resolution.resolutionStatus === 'CONTRADICTORY') return { route: 'ESCALATED_CONTRADICTORY', resolution, remainingGaps, review: await escalateToEvidenceReview(repository, resolution, 'MANUAL_REVIEW') };
  if (resolution.retryAllowed) return { route: 'RETRY', resolution, remainingGaps };
  return { route: 'ESCALATED_MAX_ATTEMPTS', resolution, remainingGaps, review: await escalateToEvidenceReview(repository, resolution, 'NEED_MORE_INFORMATION') };
}

// ---------------------------------------------------------------------------------------------------------------
// Cancellation ("Cancel Evidence Request" / "Cancel Upload Request" + "Update Cancelled Case" + audit)
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
