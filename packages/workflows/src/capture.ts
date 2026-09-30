/**
 * Requests that are not automated yet. The customer can start any request from the catalog in the chat; it is recorded as a case and routed to
 * the stage that owns it (profiling, verifier task, processing). No check runs, nothing is approved or changed, and the customer is told so.
 */
import { type CaseRecord, type RequestType, TargetAuditEvents, stageById } from '@sbo/domain';
import { type Repository, now, uniqueMillis } from '@sbo/persistence';

export const capturedStatus = 'REQUEST_CAPTURED';

export async function captureRequest(repository: Repository, caseRecord: CaseRecord, requestType: RequestType, sessionId: string): Promise<{ stageName: string; queue: string }> {
  const stage = stageById(requestType.stage);
  if (!stage) throw new Error(`UNKNOWN_STAGE:${requestType.stage}`);
  const timestamp = now();
  await repository.transaction(async (transaction) => {
    await transaction.persistRuntimeCase({ caseRunId: caseRecord.caseRunId, caseId: caseRecord.caseId, submissionVersion: caseRecord.submissionVersion, country: caseRecord.country, requestType: requestType.id, businessName: caseRecord.businessName, businessIdentifier: caseRecord.businessIdentifier, customerId: caseRecord.customerId, representativeName: caseRecord.representativeName, status: capturedStatus, currentStage: `${stage.id}_QUEUE`, finalOutcome: '', targetQueue: stage.queue, humanReviewRequired: false, createdAt: timestamp, updatedAt: timestamp, primaryReasonCode: 'NOT_AUTOMATED' });
    await transaction.appendAudit({ eventId: `EVT-${caseRecord.caseRunId}-CAPTURED-${uniqueMillis()}`, caseRunId: caseRecord.caseRunId, submissionVersion: caseRecord.submissionVersion, timestamp, actor: 'SBO.01', eventType: TargetAuditEvents.REQUEST_CAPTURED, stage: stage.id, previousState: '', newState: capturedStatus, ruleId: '', reasonCode: 'NOT_AUTOMATED', evidenceReference: sessionId, details: { requestTypeId: requestType.id, requestLabel: requestType.label, stage: stage.id, queue: stage.queue, automated: false } });
  });
  return { stageName: stage.name, queue: stage.queue };
}