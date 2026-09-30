/**
 * Workflow 91 — Human Review Portal, ported exactly as the uploaded JSON defines it (dispositions: APPROVE / NEED_MORE_INFORMATION / REJECT).
 * The newer exception-level dispositions (e.g. RESOLVED_PASS) are NOT in the upload and are only proposed in docs/post-parity-enhancements.md.
 */
import { type Communication, type Decision, type HumanReview, SourceAuditEvents } from '@sbo/domain';
import { fillTemplate } from '@sbo/governance';
import { type Repository, now, uniqueMillis } from '@sbo/persistence';

export const reviewOpenStatuses = ['PENDING', 'PENDING_REJECTION_CONFIRMATION'];
export type ReviewerDecision = 'APPROVE' | 'NEED_MORE_INFORMATION' | 'REJECT';

const outcomeConfiguration: Record<ReviewerDecision, { targetQueue: string; nextAction: string; templateId: string; summary: string; status: string }> = {
  APPROVE: { targetQueue: 'ORDER_READINESS', nextAction: 'Proceed to the next controlled operational step. No production write-back has been performed.', templateId: 'TPL-APPROVE', summary: 'A human reviewer approved the request after reviewing the available evidence.', status: 'READY_TO_PROCEED' },
  NEED_MORE_INFORMATION: { targetQueue: 'CUSTOMER_FOLLOW_UP', nextAction: 'Request the additional information identified by the reviewer and keep the case open.', templateId: 'TPL-NMI', summary: 'A human reviewer determined that additional information is required before the assessment can be completed.', status: 'WAITING_FOR_INFORMATION' },
  REJECT: { targetQueue: 'CASE_CLOSURE', nextAction: 'Prepare the rejection communication for approval and close the synthetic case after the communication is confirmed.', templateId: 'TPL-REJECT', summary: 'A human reviewer confirmed that the request cannot proceed based on the current evidence and prototype rules.', status: 'REJECTED_CONFIRMED' },
};

export interface ReviewPackage {
  reviewId: string; caseRunId: string; requestedAt: string; reviewQueue: string; reviewStatus: string; agentRecommendation: string; submissionVersion: number;
  originalDecisionId: string; originalOutcome: string; originalPrimaryReasonCode: string; originalSecondaryReasonCodes: string[]; originalTargetQueue: string; originalNextAction: string; originalCustomerSafeSummary: string; originalMissingInformation: string[]; originalConflicts: string[];
  businessName: string; businessIdentifier: string; customerId: string; representativeName: string; representativeRole: string; requestedAuthority: string; requestNarrative: string; country: string; prototypeData: true;
}

/** "Check Review Status" + "Prepare Review Package". Throws REVIEW_NOT_FOUND / REVIEW_ALREADY_COMPLETED (source "Show Review Already Completed"). */
export async function getReviewPackage(repository: Repository, reviewId: string): Promise<ReviewPackage> {
  const review = await repository.getReview(reviewId.trim());
  if (!review) throw new Error('REVIEW_NOT_FOUND');
  if (!reviewOpenStatuses.includes(review.reviewStatus.toUpperCase())) throw new Error('REVIEW_ALREADY_COMPLETED');
  const [decision, caseRecord] = await Promise.all([repository.getDecision(review.caseRunId), repository.getCase(review.caseRunId)]);
  if (!decision) throw new Error('DECISION_NOT_FOUND');
  if (!caseRecord) throw new Error(`CASE_NOT_FOUND:${review.caseRunId}`);
  return {
    reviewId: review.reviewId, caseRunId: review.caseRunId, requestedAt: review.requestedAt, reviewQueue: review.reviewQueue, reviewStatus: review.reviewStatus, agentRecommendation: review.agentRecommendation, submissionVersion: decision.submissionVersion,
    originalDecisionId: decision.decisionId, originalOutcome: decision.outcome, originalPrimaryReasonCode: decision.primaryReasonCode, originalSecondaryReasonCodes: decision.secondaryReasonCodes, originalTargetQueue: decision.targetQueue, originalNextAction: decision.nextAction, originalCustomerSafeSummary: decision.customerSafeSummary, originalMissingInformation: decision.missingInformation, originalConflicts: decision.conflicts,
    businessName: caseRecord.businessName, businessIdentifier: caseRecord.businessIdentifier, customerId: caseRecord.customerId, representativeName: caseRecord.representativeName, representativeRole: caseRecord.representativeRole, requestedAuthority: caseRecord.requestedAuthority, requestNarrative: caseRecord.requestNarrative, country: caseRecord.country, prototypeData: true,
  };
}

export interface ReviewCompletionInput { reviewerName: string; reviewerDecision: ReviewerDecision; reviewerComments: string; overrideReason?: string; }
export interface ReviewCompletionResult { decision: Decision; review: HumanReview; communication: Communication; }

export async function completeHumanReview(repository: Repository, reviewId: string, input: ReviewCompletionInput): Promise<ReviewCompletionResult> {
  // One transaction: the review row is locked (Postgres FOR UPDATE), so two simultaneous submissions cannot both complete it.
  return repository.transaction(async (transaction) => {
    const review = await transaction.getReview(reviewId.trim());
    if (!review) throw new Error('REVIEW_NOT_FOUND');
    if (!reviewOpenStatuses.includes(review.reviewStatus.toUpperCase())) throw new Error('REVIEW_ALREADY_COMPLETED');
    // "Validate Reviewer Submission"
    const reviewerName = input.reviewerName.trim();
    const reviewerDecision = String(input.reviewerDecision).trim().toUpperCase() as ReviewerDecision;
    const reviewerComments = input.reviewerComments.trim();
    const overrideReason = (input.overrideReason ?? '').trim();
    if (!reviewerName) throw new Error('REVIEWER_NAME_REQUIRED');
    if (!(reviewerDecision in outcomeConfiguration)) throw new Error(`UNSUPPORTED_REVIEWER_DECISION:${reviewerDecision}`);
    if (!reviewerComments) throw new Error('REVIEWER_COMMENTS_REQUIRED');
    if (review.agentRecommendation.toUpperCase() === 'REJECT' && reviewerDecision !== 'REJECT' && !overrideReason) throw new Error('OVERRIDE_REASON_REQUIRED');
    const [decision, caseRecord, runtimeCase] = await Promise.all([transaction.getDecision(review.caseRunId), transaction.getCase(review.caseRunId), transaction.getRuntimeCase(review.caseRunId)]);
    if (!decision) throw new Error('DECISION_NOT_FOUND');
    if (!caseRecord) throw new Error(`CASE_NOT_FOUND:${review.caseRunId}`);
    const selected = outcomeConfiguration[reviewerDecision];
    const completedAt = now();
    const completedReview: HumanReview = { ...review, reviewerName, reviewerDecision, reviewerComments, overrideReason, reviewStatus: 'COMPLETED', completedAt };
    // "Update Final Decision": original decision_id / primary reason / created_at are retained.
    const finalDecision: Decision = { ...decision, outcome: reviewerDecision, secondaryReasonCodes: [...new Set([...decision.secondaryReasonCodes, 'HUMAN_REVIEW_COMPLETED'])], humanReviewRequired: false, targetQueue: selected.targetQueue, nextAction: selected.nextAction, customerSafeSummary: selected.summary, communicationTemplateId: selected.templateId, internalSummary: `Human review completed by ${reviewerName}. Comments: ${reviewerComments}` };
    const template = await transaction.getTemplate(selected.templateId);
    if (!template) throw new Error(`COMMUNICATION_TEMPLATE_NOT_FOUND:${selected.templateId}`);
    const values = { case_id: review.caseRunId, business_name: caseRecord.businessName, representative_name: caseRecord.representativeName, outcome: reviewerDecision, reason_code: decision.primaryReasonCode, queue: selected.targetQueue, next_action: selected.nextAction, missing_items: reviewerDecision === 'NEED_MORE_INFORMATION' ? reviewerComments : (decision.missingInformation.join('; ') || 'Please refer to the reviewer comments.') };
    const communication: Communication = { communicationId: `COMM-${review.caseRunId}-V${decision.submissionVersion}-HUMAN`, caseRunId: review.caseRunId, audience: template.audience, templateId: template.templateId, subject: fillTemplate(template.subjectTemplate, values), body: fillTemplate(template.bodyTemplate, values), status: 'DRAFT', approvalRequired: true, sent: false, createdAt: completedAt };
    await transaction.persistReview(completedReview);
    await transaction.persistDecision(finalDecision);
    await transaction.persistCommunication(communication);
    // The source's "Update Runtime Case After Review" node writes only human_review_required=false (and blanks case_Run_ID); the prepared
    // status/stage record is never persisted. The target persists the prepared record (documented as a source defect, docs/07).
    if (runtimeCase) await transaction.persistRuntimeCase({ ...runtimeCase, status: selected.status, currentStage: 'HUMAN_REVIEW_COMPLETE', finalOutcome: reviewerDecision, primaryReasonCode: decision.primaryReasonCode, targetQueue: selected.targetQueue, humanReviewRequired: false, updatedAt: completedAt });
    await transaction.appendAudit({ eventId: `EVT-${review.caseRunId}-HUMAN-${uniqueMillis()}`, caseRunId: review.caseRunId, submissionVersion: decision.submissionVersion, timestamp: completedAt, actor: reviewerName, eventType: SourceAuditEvents.HUMAN_REVIEW_COMPLETED, stage: 'HUMAN_REVIEW', previousState: review.agentRecommendation, newState: reviewerDecision, ruleId: '', reasonCode: decision.primaryReasonCode, evidenceReference: `Review ID: ${review.reviewId}`, details: { reviewerDecision, overrideReason, originalOutcome: decision.outcome } });
    return { decision: finalDecision, review: completedReview, communication };
  });
}
