/**
 * Reopen workflow (replaces the separate "resubmission" screen). A reviewer looking at a rejected, incomplete or manual-review case on the
 * review dashboard can reopen it: a new version of the same logical case is created (AUTH-101 → AUTH-101-V2), the previous version is marked
 * as reopened, and the customer's chat is put back into "attach your documents" for the new version — so corrections are made in the chat,
 * not on a form.
 */
import { intakeDocumentTypes, documentLabels, SourceAuditEvents, TargetAuditEvents, type CaseRecord, type EvidenceRequest } from '@sbo/domain';
import { type Repository, now, uniqueMillis } from '@sbo/persistence';
import { reopenableOutcomes, reviewOpenStatuses } from './human-review.js';
import { openEvidenceRequest, reopenedStatus } from './super-agent.js';

/** A reviewer reopens from the dashboard; the customer reopens a closed rejection from the chat by furnishing proof (sessionId = that chat). */
export interface ReopenInput { caseRunId: string; reviewerName: string; comments: string; initiatedBy?: 'REVIEWER' | 'CUSTOMER'; sessionId?: string; }
export interface ReopenResult { original: CaseRecord; reopened: CaseRecord; request: EvidenceRequest; customerNotified: boolean; }

export async function reopenCase(repository: Repository, input: ReopenInput): Promise<ReopenResult> {
  return repository.transaction(async (transaction) => {
    const reviewerName = input.reviewerName.trim();
    const comments = input.comments.trim();
    if (!reviewerName) throw new Error('REVIEWER_NAME_REQUIRED');
    if (!comments) throw new Error('REVIEWER_COMMENTS_REQUIRED');
    const original = await transaction.getCase(input.caseRunId.trim());
    if (!original) throw new Error(`CASE_NOT_FOUND:${input.caseRunId}`);
    const [decision, runtimeCase, requests, reviews] = await Promise.all([transaction.getDecision(original.caseRunId), transaction.getRuntimeCase(original.caseRunId), transaction.getEvidenceRequests(original.caseRunId), transaction.getReviews(original.caseRunId)]);
    // A case that stopped at the document request (no decision yet) can be reopened while its evidence review is still open.
    const evidenceStop = !decision && reviews.some((review) => reviewOpenStatuses.includes(review.reviewStatus.toUpperCase()));
    if ((decision ? !reopenableOutcomes.includes(decision.outcome) : !evidenceStop) || runtimeCase?.status === reopenedStatus) throw new Error('REOPEN_NOT_ALLOWED');
    const version = original.submissionVersion + 1;
    const reopened = await transaction.createIntakeCase({ record: { ...original, caseRunId: `${original.caseId}-V${version}`, caseId: original.caseId, submissionVersion: version, documentsSubmitted: '', submittedAt: now() } });
    const timestamp = now();
    // The previous version is closed; any review still open on it is closed with the reviewer's note.
    if (runtimeCase) await transaction.persistRuntimeCase({ ...runtimeCase, status: reopenedStatus, currentStage: 'REOPENED', humanReviewRequired: false, targetQueue: reopened.caseRunId, updatedAt: timestamp });
    for (const review of reviews) if (reviewOpenStatuses.includes(review.reviewStatus.toUpperCase())) await transaction.persistReview({ ...review, reviewStatus: 'CLOSED_REOPENED', reviewerName, reviewerDecision: 'REOPEN', reviewerComments: comments, completedAt: timestamp });
    const sessionId = input.sessionId ?? requests[0]?.sessionId ?? '';
    const byCustomer = input.initiatedBy === 'CUSTOMER';
    const request = await openEvidenceRequest(transaction, {
      caseRunId: reopened.caseRunId, submissionVersion: version, sessionId, originatingCheckType: 'DOCUMENT_INTAKE', reasonCode: 'CASE_REOPENED', previousState: original.caseRunId,
      requestedItems: intakeDocumentTypes.map((type) => documentLabels[type]),
      message: byCustomer ? `Thank you. I have reopened your earlier request as case ${reopened.caseRunId}.\n\nPlease attach these documents (current versions, including the proof you mentioned):\n${intakeDocumentTypes.map((type) => `- ${documentLabels[type]}`).join('\n')}` : `A reviewer reopened your request as case ${reopened.caseRunId}.\n\nReviewer note: ${comments}\n\nPlease attach these documents (corrected or current versions):\n${intakeDocumentTypes.map((type) => `- ${documentLabels[type]}`).join('\n')}`,
    });
    // Put the customer's conversation back into "attach your documents" for the new version.
    if (sessionId) await transaction.saveSession({ sessionId, caseRunId: reopened.caseRunId, step: 'AWAITING_EVIDENCE', evidenceRequestId: request.evidenceRequestId, requestTypeId: '', intake: { representativeName: '', businessName: '', businessIdentifier: '' }, updatedAt: timestamp });
    await transaction.appendAudit({ eventId: `EVT-${original.caseRunId}-REOPEN-${uniqueMillis()}`, caseRunId: original.caseRunId, submissionVersion: original.submissionVersion, timestamp, actor: reviewerName, eventType: TargetAuditEvents.CASE_REOPENED, stage: 'REVIEW_DASHBOARD', previousState: decision?.outcome ?? 'EVIDENCE_REVIEW', newState: reopenedStatus, ruleId: '', reasonCode: byCustomer ? 'REOPENED_BY_CUSTOMER_PROOF' : 'REOPENED_BY_REVIEWER', evidenceReference: reopened.caseRunId, details: { original_case_run_id: original.caseRunId, reopened_case_run_id: reopened.caseRunId, original_version: original.submissionVersion, reopened_version: version, comments, initiatedBy: byCustomer ? 'CUSTOMER' : 'REVIEWER', customerNotified: Boolean(sessionId), audit_alias: SourceAuditEvents.CASE_RESUBMITTED } });
    return { original, reopened, request, customerNotified: Boolean(sessionId) };
  });
}
