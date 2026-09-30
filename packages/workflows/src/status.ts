/**
 * Case-status adapter. Workflow 93 (Case Status Portal) is ABSENT from the uploaded n8n exports, so this is a documented
 * platform adapter that reads only persisted runtime state — it is not node-for-node parity.
 */
import { type Repository } from '@sbo/persistence';

export interface CaseStatusView {
  caseIdentifiers: { caseRunId: string; caseId: string; submissionVersion: number };
  currentStatus: string; currentStage: string; outcome: string; primaryReason: string; summary: string; nextAction: string; targetQueue: string;
  humanReview: { reviewId: string; status: string; queue: string } | null;
  latestEvidenceRequest: { evidenceRequestId: string; status: string; evidenceChannel: string; requestedItems: string[]; attemptCount: number; maxAttempts: number } | null;
  latestEvidence: { evidenceId: string; evidenceType: string; evidenceSource: string; validationStatus: string; providedAt: string } | null;
  latestCommunication: { communicationId: string; templateId: string; subject: string; body: string; status: string } | null;
  dataQualityWarnings: string[];
  syntheticDataDisclaimer: true;
}

export async function getCaseStatus(repository: Repository, caseRunId: string): Promise<CaseStatusView> {
  const [caseRecord, runtimeCase, decision, requests, reviews, communications] = await Promise.all([repository.getCase(caseRunId), repository.getRuntimeCase(caseRunId), repository.getDecision(caseRunId), repository.getEvidenceRequests(caseRunId), repository.getReviews(caseRunId), repository.getCommunications(caseRunId)]);
  if (!caseRecord) throw new Error('CASE_NOT_FOUND');
  const latestRequest = requests[0];
  const evidence = latestRequest ? await repository.getEvidence(latestRequest.evidenceRequestId) : [];
  const latestEvidence = evidence.at(-1);
  const latestReview = [...reviews].sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0];
  const latestCommunication = communications[0];
  const warnings: string[] = ['All data shown is synthetic. No production system was read or updated.'];
  if (!runtimeCase) warnings.push('No runtime case record exists yet; the case has not been assessed.');
  if (runtimeCase && !decision) warnings.push('A runtime case exists without a governed decision record.');
  if (decision && runtimeCase && runtimeCase.finalOutcome && runtimeCase.finalOutcome !== decision.outcome && runtimeCase.status !== 'SUPERSEDED_BY_RESUBMISSION') warnings.push('The runtime case outcome and the latest decision outcome differ.');
  if (requests.filter((request) => ['OPEN', 'RECEIVED', 'PARTIALLY_RECEIVED', 'INSUFFICIENT'].includes(request.status)).length > 1) warnings.push('More than one evidence request is active for this case; the latest is shown.');
  warnings.push('Workflow 93 was absent from the supplied n8n exports; this status view is a platform adapter, not a ported workflow.');
  return {
    caseIdentifiers: { caseRunId: caseRecord.caseRunId, caseId: caseRecord.caseId, submissionVersion: caseRecord.submissionVersion },
    currentStatus: runtimeCase?.status ?? 'INITIAL', currentStage: runtimeCase?.currentStage ?? 'INITIAL', outcome: decision?.outcome ?? '', primaryReason: decision?.primaryReasonCode ?? '',
    summary: decision?.customerSafeSummary ?? 'No assessment has been completed.', nextAction: decision?.nextAction ?? 'Start the assessment.', targetQueue: runtimeCase?.targetQueue ?? '',
    humanReview: latestReview ? { reviewId: latestReview.reviewId, status: latestReview.reviewStatus, queue: latestReview.reviewQueue } : null,
    latestEvidenceRequest: latestRequest ? { evidenceRequestId: latestRequest.evidenceRequestId, status: latestRequest.status, evidenceChannel: latestRequest.evidenceChannel, requestedItems: latestRequest.requestedItems, attemptCount: latestRequest.attemptCount, maxAttempts: latestRequest.maxAttempts } : null,
    latestEvidence: latestEvidence ? { evidenceId: latestEvidence.evidenceId, evidenceType: latestEvidence.evidenceType, evidenceSource: latestEvidence.evidenceSource, validationStatus: latestEvidence.validationStatus, providedAt: latestEvidence.providedAt } : null,
    latestCommunication: latestCommunication ? { communicationId: latestCommunication.communicationId, templateId: latestCommunication.templateId, subject: latestCommunication.subject, body: latestCommunication.body, status: latestCommunication.status } : null,
    dataQualityWarnings: warnings, syntheticDataDisclaimer: true,
  };
}
