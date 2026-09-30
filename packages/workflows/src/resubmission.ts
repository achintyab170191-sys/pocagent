/**
 * Workflow 92 — Resubmission Portal: formal, versioned resubmission (e.g. AUTH-008-V1 → AUTH-008-V2).
 * Distinct from same-case evidence continuation (Workflows 95/96), which stays on one case_run_id.
 */
import { type AgentRuntime } from '@sbo/agent-runtime';
import { SourceAuditEvents } from '@sbo/domain';
import { type Repository, now, uniqueMillis } from '@sbo/persistence';
import { evaluateCase, type AssessmentResult } from './super-agent.js';

export interface ResubmissionInput { originalCaseRunId: string; revisedCaseRunId: string; resubmissionComments: string; }

/**
 * One atomic step: eligibility check, revised assessment, supersede and audit commit together, and the original decision row is locked
 * first, so two parallel resubmissions of the same case cannot both pass the "already resubmitted" guard (security review SEC-03).
 */
export async function createResubmission(repository: Repository, input: ResubmissionInput, agentRuntime: AgentRuntime): Promise<AssessmentResult> {
  return repository.transaction((transaction) => createResubmissionLocked(transaction, input, agentRuntime));
}

async function createResubmissionLocked(repository: Repository, input: ResubmissionInput, agentRuntime: AgentRuntime): Promise<AssessmentResult> {
  const originalId = input.originalCaseRunId.trim();
  const revisedId = input.revisedCaseRunId.trim();
  // "Check Resubmission Eligibility": the original decision must exist with outcome NEED_MORE_INFORMATION.
  const originalDecision = await repository.getDecision(originalId);
  if (!originalDecision || originalDecision.outcome !== 'NEED_MORE_INFORMATION') throw new Error('RESUBMISSION_NOT_ALLOWED');
  const [originalCase, revisedCase] = await Promise.all([repository.getCase(originalId), repository.getCase(revisedId)]);
  if (!originalCase || !revisedCase) throw new Error('RESUBMISSION_CASE_NOT_FOUND');
  // "Validate Version Relationship"
  if (originalCase.caseId !== revisedCase.caseId || !(revisedCase.submissionVersion > originalCase.submissionVersion) || originalCase.caseRunId === revisedCase.caseRunId) throw new Error('INVALID_REVISED_VERSION');
  // Target hardening (not in source): a superseded original cannot be resubmitted a second time.
  const originalRuntime = await repository.getRuntimeCase(originalCase.caseRunId);
  if (originalRuntime?.status === 'SUPERSEDED_BY_RESUBMISSION') throw new Error('RESUBMISSION_ALREADY_CREATED');
  // "Run Revised SBO.02 Assessment" (source calls workflow "02 - SBO.02 - Profiling Super Agent", which is not in the upload; the
  // target runs the uploaded 03 orchestrator on the revised case_run_id — recorded in docs/07).
  const assessment = await evaluateCase(repository, agentRuntime, revisedCase.caseRunId);
  await repository.transaction(async (transaction) => {
    const runtimeCase = await transaction.getRuntimeCase(originalCase.caseRunId);
    // "Mark Original Case Superseded" (source stores the revised case_run_id in target_queue).
    if (runtimeCase) await transaction.persistRuntimeCase({ ...runtimeCase, status: 'SUPERSEDED_BY_RESUBMISSION', currentStage: 'RESUBMITTED', humanReviewRequired: false, targetQueue: revisedCase.caseRunId, updatedAt: now() });
    await transaction.appendAudit({ eventId: `EVT-${originalCase.caseRunId}-RESUBMISSION-${uniqueMillis()}`, caseRunId: originalCase.caseRunId, submissionVersion: originalCase.submissionVersion, timestamp: now(), actor: 'CUSTOMER_SYNTHETIC', eventType: SourceAuditEvents.CASE_RESUBMITTED, stage: 'RESUBMISSION', previousState: 'WAITING_FOR_INFORMATION', newState: 'RESUBMITTED', ruleId: '', reasonCode: 'REVISED_EVIDENCE_SUBMITTED', evidenceReference: revisedCase.caseRunId, details: { original_case_run_id: originalCase.caseRunId, revised_case_run_id: revisedCase.caseRunId, original_version: originalCase.submissionVersion, revised_version: revisedCase.submissionVersion, revised_outcome: assessment.decision.outcome, comments: input.resubmissionComments } });
  });
  return assessment;
}
