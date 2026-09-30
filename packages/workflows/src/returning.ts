/**
 * A returning customer (same full name + same company): find the case they already have instead of opening a duplicate.
 *
 *   DOCUMENTS  a document request is still open       → tell them the case is in progress, and resume it in the same chat
 *   SPECIALIST the checks are done, a human is on it  → tell them it is in progress; nothing more is needed (a pending rejection is never revealed)
 *   LEAD       a new lead awaiting onboarding         → tell them the lead is registered and onboarding is pending
 *   APPROVED   already approved                       → tell them; nothing more is needed
 *   CLOSED     a human closed it, or the customer cancelled its document request → offer to reopen it so they can submit the correct proof
 *
 * Identification is by name and company only (there is no sign-in in this prototype), so the answer is limited to a case reference,
 * a status and the names of the documents still needed.
 */
import { TargetAuditEvents, businessNamesMatch, sameName, type CaseRecord, type EvidenceRequest } from '@sbo/domain';
import { type Repository, now, uniqueMillis } from '@sbo/persistence';
import { onboardingPendingStatus, capturedStatus } from './capture.js';
import { reopenableOutcomes, reviewOpenStatuses } from './human-review.js';
import { openEvidenceRequest, reopenedStatus } from './super-agent.js';

export type PriorCase =
  | { kind: 'DOCUMENTS'; caseRecord: CaseRecord; request: EvidenceRequest }
  | { kind: 'SPECIALIST'; caseRecord: CaseRecord }
  | { kind: 'LEAD'; caseRecord: CaseRecord }
  | { kind: 'APPROVED'; caseRecord: CaseRecord }
  | { kind: 'CLOSED'; caseRecord: CaseRecord; how: 'DECISION' | 'CANCELLED'; reasonCode: string };

const openRequestStatuses = ['OPEN', 'RECEIVED', 'PARTIALLY_RECEIVED', 'INSUFFICIENT'];
const rank: Record<PriorCase['kind'], number> = { DOCUMENTS: 1, SPECIALIST: 1, LEAD: 1, CLOSED: 2, APPROVED: 3 };

/** Where one case (its latest version) stands, or undefined when it is not a New LOA / lead case or has been superseded. */
export async function classifyCase(repository: Repository, caseRecord: CaseRecord): Promise<PriorCase | undefined> {
  const [runtime, decision, requests, reviews] = await Promise.all([repository.getRuntimeCase(caseRecord.caseRunId), repository.getDecision(caseRecord.caseRunId), repository.getEvidenceRequests(caseRecord.caseRunId), repository.getReviews(caseRecord.caseRunId)]);
  if (runtime?.status === capturedStatus || runtime?.status === reopenedStatus) return undefined;
  if (caseRecord.requestType === 'NEW_LEAD') return runtime?.status === onboardingPendingStatus ? { kind: 'LEAD', caseRecord } : undefined;
  const latestRequests = [...requests].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const openRequest = latestRequests.find((request) => openRequestStatuses.includes(request.status));
  if (openRequest) return { kind: 'DOCUMENTS', caseRecord, request: openRequest };
  const reviewOpen = reviews.some((review) => reviewOpenStatuses.includes(review.reviewStatus.toUpperCase()));
  if (decision) {
    if (decision.humanReviewRequired || reviewOpen) return { kind: 'SPECIALIST', caseRecord };
    if (decision.outcome === 'APPROVE') return { kind: 'APPROVED', caseRecord };
    if (reopenableOutcomes.includes(decision.outcome)) return { kind: 'CLOSED', caseRecord, how: 'DECISION', reasonCode: decision.primaryReasonCode };
    return undefined;
  }
  if (reviewOpen) return { kind: 'SPECIALIST', caseRecord };
  if (latestRequests[0]?.status === 'CANCELLED') return { kind: 'CLOSED', caseRecord, how: 'CANCELLED', reasonCode: latestRequests[0].originatingReasonCode };
  return undefined;
}

/** The customer's most relevant existing case: in progress first, then closed, then approved; newest first within each. */
export async function findPriorCase(repository: Repository, representativeName: string, businessName: string): Promise<PriorCase | undefined> {
  const matching = (await repository.listCases()).filter((entry) => sameName(entry.representativeName, representativeName) && businessNamesMatch(entry.businessName, businessName));
  const latestByCase = new Map<string, CaseRecord>();
  for (const entry of matching) { const seen = latestByCase.get(entry.caseId); if (!seen || entry.submissionVersion > seen.submissionVersion) latestByCase.set(entry.caseId, entry); }
  const classified = (await Promise.all([...latestByCase.values()].map((entry) => classifyCase(repository, entry)))).filter((entry): entry is PriorCase => Boolean(entry));
  return classified.sort((left, right) => rank[left.kind] - rank[right.kind] || right.caseRecord.submittedAt.localeCompare(left.caseRecord.submittedAt) || right.caseRecord.caseRunId.localeCompare(left.caseRecord.caseRunId))[0];
}

/** The customer cancelled a document request and now wants the case back: the same case asks for the same documents again. */
export async function resumeCancelledCase(repository: Repository, caseRunId: string, sessionId: string): Promise<EvidenceRequest> {
  const requests = [...(await repository.getEvidenceRequests(caseRunId))].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const cancelled = requests[0];
  if (cancelled?.status !== 'CANCELLED') throw new Error('REOPEN_NOT_ALLOWED');
  const request = await openEvidenceRequest(repository, { caseRunId, submissionVersion: cancelled.submissionVersion, sessionId, originatingCheckType: cancelled.originatingCheckType, reasonCode: cancelled.originatingReasonCode, requestedItems: cancelled.requestedItems, previousState: 'EVIDENCE_REQUEST_CANCELLED', message: cancelled.customerMessage });
  await repository.appendAudit({ eventId: `EVT-${caseRunId}-REOPEN-${uniqueMillis()}`, caseRunId, submissionVersion: cancelled.submissionVersion, timestamp: now(), actor: 'Customer (chat)', eventType: TargetAuditEvents.CASE_REOPENED, stage: 'EVIDENCE_COLLECTION', previousState: 'EVIDENCE_REQUEST_CANCELLED', newState: 'WAITING_FOR_EVIDENCE', ruleId: '', reasonCode: 'REOPENED_BY_CUSTOMER_CONFIRMATION', evidenceReference: request.evidenceRequestId, details: { initiatedBy: 'CUSTOMER', resumedCancelledRequest: cancelled.evidenceRequestId } });
  return request;
}
