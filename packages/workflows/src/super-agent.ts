/**
 * Workflow 03 — SBO.02 Agentic Reasoning Orchestrator.
 *
 * Provisional (agent) vs governed (Finalizer) separation is preserved: the agent runtime only sees the toolbox and
 * returns a provisional recommendation; finalizeDecision() from @sbo/governance produces the governed outcome.
 */
import {
  type AgentRuntime, type SuperAgentContext, type ToolObservation, type ToolTraceStep, type UtilityToolbox,
  fallbackProvisional, sbo02ToolDefinitions,
} from '@sbo/agent-runtime';
import {
  type CaseRecord, type Decision, type EvidenceRequest, type HumanReview, type ProvisionalRecommendation, type UtilityResult, type Communication,
  TargetAuditEvents, mandatoryCheckTypes,
} from '@sbo/domain';
import { finalizeDecision } from '@sbo/governance';
import { type Repository, now, uniqueMillis } from '@sbo/persistence';
import { executeUtility, toolNameFor, utilityCatalog } from './utilities.js';

// ---------------------------------------------------------------------------------------------------------------
// "Resolve Case Request"
// ---------------------------------------------------------------------------------------------------------------

export interface ResolvedCaseRequest { chatInput: string; caseIdFound: boolean; caseRunId: string; submissionVersion: number | null; sessionId: string; }

export function resolveCaseRequest(input: string, sessionId = ''): ResolvedCaseRequest {
  const chatInput = String(input || '').trim();
  const match = chatInput.toUpperCase().match(/AUTH-\d{3}(?:-V\d+)?/);
  if (!match) return { chatInput, caseIdFound: false, caseRunId: '', submissionVersion: null, sessionId };
  const caseRunId = match[0];
  const version = caseRunId.match(/-V(\d+)$/);
  return { chatInput, caseIdFound: true, caseRunId, submissionVersion: version ? Number(version[1]) : 1, sessionId };
}

export const invalidRequestMessage = 'I could not find a supported synthetic Case Run ID. Enter a case such as AUTH-001, AUTH-003, or AUTH-008-V2.';
export const caseNotFoundMessage = (caseRunId: string): string => `Synthetic case ${caseRunId} was not found. No assessment was performed.`;

// ---------------------------------------------------------------------------------------------------------------
// "Prepare Agent Context"
// ---------------------------------------------------------------------------------------------------------------

const passing = new Set(['PASS', 'PASS_WITH_FLAG']);
export const isPassing = (result: UtilityResult | undefined): boolean => Boolean(result && passing.has(result.status.toUpperCase()));

function snakeResult(result: UtilityResult): Record<string, unknown> {
  return {
    result_id: result.resultId, sequence: result.sequence, agent_id: result.agentId, utility_name: result.utilityName, check_type: result.checkType.toUpperCase(), status: result.status.toUpperCase(), findings: result.findings, rule_ids: result.ruleIds, reason_codes: result.reasonCodes, evidence_references: result.evidenceReferences, confidence: result.confidence, human_review_required: result.humanReviewRequired, recommended_next_step: result.recommendedNextStep,
    resolved_by_additional_evidence: result.ruleIds.includes('EVID-001') || result.findings.evidence_resolution === true,
    superseded: result.superseded,
  };
}

export async function prepareAgentContext(repository: Repository, caseRecord: CaseRecord, chatInput: string, sessionId: string): Promise<SuperAgentContext> {
  const existing = (await repository.getRuntimeResults(caseRecord.caseRunId, caseRecord.submissionVersion)).filter((row) => row.checkType.trim() !== '').sort((left, right) => left.sequence - right.sequence);
  const passingTypes = new Set(existing.filter((row) => isPassing(row)).map((row) => row.checkType.toUpperCase()));
  const pending = mandatoryCheckTypes.filter((checkType) => !passingTypes.has(checkType));
  return {
    chatInput,
    caseRunId: caseRecord.caseRunId,
    submissionVersion: caseRecord.submissionVersion,
    sessionId,
    assessmentCycle: existing.length > 0 ? 'RESUMED' : 'INITIAL',
    nextRequiredCheck: pending[0] ?? '',
    completedMandatoryChecks: mandatoryCheckTypes.filter((checkType) => passingTypes.has(checkType)),
    pendingMandatoryChecks: [...pending],
    evidenceResolvedChecks: existing.filter((row) => row.ruleIds.includes('EVID-001') || row.findings.evidence_resolution === true).map((row) => row.checkType.toUpperCase()),
    caseContext: { case_run_id: caseRecord.caseRunId, logical_case_id: caseRecord.caseId, submission_version: caseRecord.submissionVersion, country: caseRecord.country, request_type: caseRecord.requestType, business_name: caseRecord.businessName, business_identifier: caseRecord.businessIdentifier, customer_id: caseRecord.customerId, representative_name: caseRecord.representativeName, representative_role: caseRecord.representativeRole, requested_authority: caseRecord.requestedAuthority, request_narrative: caseRecord.requestNarrative, documents_submitted: caseRecord.documentsSubmitted },
    existingRuntimeResults: existing.map(snakeResult),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The agent's only capability: governed specialist tools
// ---------------------------------------------------------------------------------------------------------------

export function utilityObservation(result: UtilityResult): Record<string, unknown> {
  return { case_run_id: result.caseRunId, submission_version: result.submissionVersion, sequence: result.sequence, agent_id: result.agentId, utility_name: result.utilityName, check_type: result.checkType, status: result.status, findings: result.findings, reason_codes: result.reasonCodes, evidence_references: result.evidenceReferences, confidence: result.confidence, human_review_required: result.humanReviewRequired, recommended_next_step: result.recommendedNextStep, rule_ids: result.ruleIds, rule_status_used: result.ruleStatusUsed, is_terminal: result.isTerminal, terminal_outcome: result.terminalOutcome, prototype_data: true };
}

/**
 * Least-privilege toolbox. Refuses (without executing anything) when the call would repeat a passed check,
 * skip an incomplete earlier check, or continue after a terminal result.
 */
export function createToolbox(repository: Repository, caseRecord: CaseRecord): UtilityToolbox {
  const descriptions = new Map(sbo02ToolDefinitions.map((definition) => [definition.name, definition.description]));
  return {
    tools: utilityCatalog.map((entry) => ({ name: entry.toolName, description: descriptions.get(entry.toolName) ?? entry.toolName })),
    async call(toolName: string): Promise<ToolObservation> {
      const entry = utilityCatalog.find((candidate) => candidate.toolName === toolName);
      if (!entry) return { allowed: false, message: `UNKNOWN_TOOL:${toolName}` };
      const current = await repository.getRuntimeResults(caseRecord.caseRunId, caseRecord.submissionVersion);
      const byCheck = new Map(current.map((row) => [row.checkType.toUpperCase(), row]));
      if (current.some((row) => row.isTerminal && !isPassing(row))) return { allowed: false, message: 'TERMINAL_RESULT_ALREADY_RETURNED: do not call further tools.' };
      if (isPassing(byCheck.get(entry.checkType))) return { allowed: false, message: `${entry.checkType} already has a passing result; it must not be repeated.` };
      const blocking = utilityCatalog.find((candidate) => candidate.sequence < entry.sequence && !isPassing(byCheck.get(candidate.checkType)));
      if (blocking) return { allowed: false, message: `EARLIER_CHECK_INCOMPLETE:${blocking.checkType}. Call ${blocking.toolName} first.` };
      const result = await executeUtility(repository, { caseRunId: caseRecord.caseRunId, submissionVersion: caseRecord.submissionVersion, checkType: entry.checkType });
      return { allowed: true, result: utilityObservation(result) };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// "Classify Continuation Requirement" / "Create Evidence Request"
// ---------------------------------------------------------------------------------------------------------------

export interface ContinuationConfig { remediable: boolean; channel: string; checkType: string; requestedItems: string[]; }

export function classifyContinuation(decision: Pick<Decision, 'outcome' | 'primaryReasonCode' | 'missingInformation'>): ContinuationConfig {
  const missing = decision.missingInformation;
  const table: Record<string, ContinuationConfig> = {
    DOCUMENT_MISSING: { remediable: true, channel: 'FILE_UPLOAD', checkType: 'DOCUMENT_EXTRACTION', requestedItems: missing.length > 0 ? missing : ['Required document'] },
    DOCUMENT_UNREADABLE: { remediable: true, channel: 'FILE_UPLOAD', checkType: 'DOCUMENT_EXTRACTION', requestedItems: ['Readable replacement document'] },
    AUTHORITY_MISSING: { remediable: true, channel: 'FILE_UPLOAD', checkType: 'AUTHORITY_VALIDATION', requestedItems: ['Authority letter or approved delegation evidence'] },
    AUTHORITY_SCOPE_INSUFFICIENT: { remediable: true, channel: 'CHAT_OR_FILE', checkType: 'AUTHORITY_VALIDATION', requestedItems: ['Evidence explicitly covering the requested authority'] },
    AUTHORITY_SCOPE_AMBIGUOUS: { remediable: true, channel: 'CHAT_OR_FILE', checkType: 'AUTHORITY_VALIDATION', requestedItems: ['Exact authority clause or revised authority document'] },
    IDENTITY_MISMATCH: { remediable: true, channel: 'FILE_UPLOAD', checkType: 'IDENTITY_VALIDATION', requestedItems: ['Corrected or replacement identity evidence'] },
    DOCUMENT_CONTRADICTION: { remediable: true, channel: 'CHAT_OR_FILE', checkType: 'DOCUMENT_EXTRACTION', requestedItems: ['Clarification or corrected document addressing the contradiction'] },
    ADDITIONAL_DETAILS_REQUIRED: { remediable: true, channel: 'CHAT_TEXT', checkType: 'REQUEST_CLARIFICATION', requestedItems: ['Additional request details'] },
    CUSTOMER_CONFIRMATION_REQUIRED: { remediable: true, channel: 'CHAT_TEXT', checkType: 'CUSTOMER_CONFIRMATION', requestedItems: ['Customer confirmation'] },
    SALES_CONFIRMATION_REQUIRED: { remediable: true, channel: 'CHAT_TEXT', checkType: 'SALES_CONFIRMATION', requestedItems: ['Sales or account-team confirmation'] },
    REGISTRY_UNAVAILABLE: { remediable: false, channel: 'HUMAN_REVIEW', checkType: 'BUSINESS_VALIDATION', requestedItems: [] },
    DUPLICATE_RECORD_CONFLICT: { remediable: false, channel: 'HUMAN_REVIEW', checkType: 'SYSTEM_DATA_CHECK', requestedItems: [] },
    PROMPT_INJECTION_DETECTED: { remediable: false, channel: 'HUMAN_REVIEW', checkType: 'DOCUMENT_EXTRACTION', requestedItems: [] },
    TBD_POLICY: { remediable: false, channel: 'HUMAN_REVIEW', checkType: 'FINANCIAL_CHECK', requestedItems: [] },
    BUSINESS_INACTIVE: { remediable: false, channel: 'HUMAN_REVIEW', checkType: 'BUSINESS_VALIDATION', requestedItems: [] },
  };
  const reason = decision.primaryReasonCode.trim().toUpperCase();
  return table[reason] ?? { remediable: decision.outcome === 'NEED_MORE_INFORMATION', channel: decision.outcome === 'NEED_MORE_INFORMATION' ? 'CHAT_TEXT' : 'NONE', checkType: 'REQUEST_CLARIFICATION', requestedItems: missing };
}

export async function createEvidenceRequest(repository: Repository, decision: Decision, config: ContinuationConfig, sessionId: string): Promise<EvidenceRequest> {
  // One clock read: created_at and due_at (+48 h) come from the same instant (the source reads the clock twice, so the gap drifts by a millisecond).
  const createdMillis = Date.now();
  const timestamp = new Date(createdMillis).toISOString();
  const request: EvidenceRequest = {
    evidenceRequestId: `EVID-${decision.caseRunId}-V${decision.submissionVersion}-${uniqueMillis()}`,
    caseRunId: decision.caseRunId,
    submissionVersion: decision.submissionVersion,
    sessionId,
    processCode: 'P-1.1',
    originatingCheckType: config.checkType,
    originatingReasonCode: decision.primaryReasonCode,
    evidenceChannel: config.channel,
    requestedItems: config.requestedItems,
    customerMessage: config.requestedItems.length > 0 ? `Please provide the following additional evidence:\n${config.requestedItems.map((item) => `- ${item}`).join('\n')}` : 'Please provide the additional information needed to continue.',
    status: 'OPEN',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: timestamp,
    dueAt: new Date(createdMillis + 48 * 60 * 60 * 1000).toISOString(),
  };
  await repository.transaction(async (transaction) => {
    await transaction.persistEvidenceRequest(request);
    const runtimeCase = await transaction.getRuntimeCase(decision.caseRunId);
    // Source "Update Case to Waiting for Evidence": status/stage/queue exactly as below; synthetic_Only is written false by the source.
    if (runtimeCase) await transaction.persistRuntimeCase({ ...runtimeCase, status: 'WAITING_FOR_EVIDENCE', currentStage: 'CUSTOMER_EVIDENCE', targetQueue: 'CUSTOMER_FOLLOW_UP', humanReviewRequired: false, updatedAt: now() });
    await transaction.appendAudit({ eventId: `EVT-${decision.caseRunId}-EVIDENCE-REQUEST-${uniqueMillis()}`, caseRunId: decision.caseRunId, submissionVersion: decision.submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: TargetAuditEvents.EVIDENCE_REQUESTED, stage: 'EVIDENCE_COLLECTION', previousState: decision.outcome, newState: 'WAITING_FOR_EVIDENCE', ruleId: decision.appliedRuleId, reasonCode: decision.primaryReasonCode, evidenceReference: request.evidenceRequestId, details: { evidenceChannel: request.evidenceChannel, requestedItems: request.requestedItems, originatingCheckType: request.originatingCheckType } });
  });
  return request;
}

/**
 * UNRESOLVED_SOURCE_GAP: no uploaded workflow creates review rows for non-evidence MANUAL_REVIEW/REJECT decisions, although the
 * exported dt_human_reviews contains REV-AUTH-004-1 and REV-AUTH-010-1. This target-side adapter follows that ID convention.
 */
export async function createReviewForDecision(repository: Repository, decision: Decision): Promise<HumanReview | undefined> {
  if (!decision.humanReviewRequired || !(decision.outcome === 'MANUAL_REVIEW' || decision.outcome === 'REJECT')) return undefined;
  return repository.transaction(async (transaction) => {
    const existing = await transaction.getReviews(decision.caseRunId);
    const open = existing.find((review) => ['PENDING', 'PENDING_REJECTION_CONFIRMATION'].includes(review.reviewStatus.toUpperCase()) && review.agentRecommendation === decision.outcome);
    if (open) return open;
    const review: HumanReview = { reviewId: `REV-${decision.caseRunId}-${existing.length + 1}`, caseRunId: decision.caseRunId, reviewQueue: decision.targetQueue, agentRecommendation: decision.outcome, reviewerName: '', reviewerDecision: '', reviewerComments: '', overrideReason: '', reviewStatus: decision.outcome === 'REJECT' ? 'PENDING_REJECTION_CONFIRMATION' : 'PENDING', requestedAt: now(), completedAt: '' };
    await transaction.persistReview(review);
    await transaction.appendAudit({ eventId: `EVT-${decision.caseRunId}-REVIEW-CREATED-${uniqueMillis()}`, caseRunId: decision.caseRunId, submissionVersion: decision.submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: TargetAuditEvents.REVIEW_CREATED, stage: 'HUMAN_REVIEW', previousState: '', newState: review.reviewStatus, ruleId: decision.appliedRuleId, reasonCode: decision.primaryReasonCode, evidenceReference: review.reviewId, details: { reviewQueue: review.reviewQueue } });
    return review;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------------------------------------------

export interface AssessmentResult {
  assessmentCycle: 'INITIAL' | 'RESUMED';
  decision: Decision;
  communication: Communication;
  provisional: ProvisionalRecommendation;
  trace: ToolTraceStep[];
  agentOutput: string;
  governanceOverride: boolean;
  governanceOverrideMessage: string;
  continuation: ContinuationConfig;
  evidenceRequest?: EvidenceRequest;
  review?: HumanReview;
}

async function runAssessment(repository: Repository, agentRuntime: AgentRuntime, caseRecord: CaseRecord, chatInput: string, sessionId: string): Promise<AssessmentResult> {
  const context = await prepareAgentContext(repository, caseRecord, chatInput, sessionId);
  const toolbox = createToolbox(repository, caseRecord);
  await repository.appendAudit({ eventId: `EVT-${caseRecord.caseRunId}-${context.assessmentCycle === 'RESUMED' ? 'RESUMED' : 'STARTED'}-${uniqueMillis()}`, caseRunId: caseRecord.caseRunId, submissionVersion: caseRecord.submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: context.assessmentCycle === 'RESUMED' ? TargetAuditEvents.ASSESSMENT_RESUMED : TargetAuditEvents.ASSESSMENT_STARTED, stage: 'ASSESSMENT', previousState: '', newState: context.assessmentCycle === 'RESUMED' ? 'ASSESSMENT_RESUMED' : 'ASSESSMENT_IN_PROGRESS', ruleId: '', reasonCode: '', evidenceReference: '', details: { nextRequiredCheck: context.nextRequiredCheck, completedMandatoryChecks: context.completedMandatoryChecks } });
  let trace: ToolTraceStep[] = [];
  let agentOutput = '';
  let provisional: ProvisionalRecommendation;
  try {
    const run = await agentRuntime.runSuperAgent(context, toolbox);
    trace = run.trace; agentOutput = run.agentOutput; provisional = run.provisional;
  } catch (error) {
    // A model/runtime failure must not block governance: persisted tool results (possibly none) are finalised conservatively.
    const message = error instanceof Error ? error.message : 'AGENT_RUNTIME_ERROR';
    await repository.appendAudit({ eventId: `EVT-${caseRecord.caseRunId}-WORKFLOW-ERROR-${uniqueMillis()}`, caseRunId: caseRecord.caseRunId, submissionVersion: caseRecord.submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: 'WORKFLOW_ERROR', stage: 'SBO.02', previousState: '', newState: 'AGENT_RUNTIME_ERROR', ruleId: '', reasonCode: 'WORKFLOW_EXECUTION_ERROR', evidenceReference: '', details: { message: message.slice(0, 500) } });
    provisional = fallbackProvisional(caseRecord.caseRunId, [], 'The agent runtime failed; the deterministic Finalizer result is authoritative.');
  }
  // "Prepare Runtime Finalization Input" → RUNTIME source; persisted results exist before the Finalizer runs.
  const { decision, communication } = await finalizeDecision(repository, caseRecord.caseRunId, caseRecord.submissionVersion, 'RUNTIME');
  const governanceOverride = provisional.provisionalOutcome !== decision.outcome;
  const continuation = classifyContinuation(decision);
  let evidenceRequest: EvidenceRequest | undefined;
  let review: HumanReview | undefined;
  if (continuation.remediable) evidenceRequest = await createEvidenceRequest(repository, decision, continuation, sessionId);
  else review = await createReviewForDecision(repository, decision);
  return {
    assessmentCycle: context.assessmentCycle, decision, communication, provisional, trace, agentOutput, governanceOverride,
    governanceOverrideMessage: governanceOverride ? `The AI Agent recommended ${provisional.provisionalOutcome}, but deterministic policy recorded ${decision.outcome}.` : 'The AI Agent recommendation and deterministic policy outcome are aligned.',
    continuation, evidenceRequest, review,
  };
}

/** Chat entry (Agentic Chat → Resolve Case Request → … → Reset Runtime Utility Results → Prepare Agent Context). */
export async function evaluateCase(repository: Repository, agentRuntime: AgentRuntime, caseRunId: string, sessionId = '', chatInput = `Evaluate ${caseRunId}`): Promise<AssessmentResult> {
  const resolved = resolveCaseRequest(caseRunId);
  if (!resolved.caseIdFound) throw new Error('CASE_ID_NOT_SUPPORTED');
  // One transaction for reset + assessment + finalization: concurrent evaluations of the same case serialise instead of interleaving rows.
  return repository.transaction(async (transaction) => {
    const caseRecord = await transaction.getCase(resolved.caseRunId);
    if (!caseRecord) throw new Error(`CASE_NOT_FOUND:${resolved.caseRunId}`);
    // TARGET HARDENING (docs/07 G-27, security review SEC-02): the source lets any chat message re-evaluate any case, which silently
    // overwrites a decision a human reviewer already completed. A reviewed or superseded case is locked until an operator resets runtime state.
    const [reviews, runtimeCase] = await Promise.all([transaction.getReviews(caseRecord.caseRunId), transaction.getRuntimeCase(caseRecord.caseRunId)]);
    if (reviews.some((review) => review.reviewStatus.toUpperCase() === 'COMPLETED') || runtimeCase?.status === 'SUPERSEDED_BY_RESUBMISSION') throw new Error(`CASE_LOCKED:${caseRecord.caseRunId}`);
    // Source deletes exactly case_run_id + submission_version before a fresh assessment.
    await transaction.deleteRuntimeResults(caseRecord.caseRunId, caseRecord.submissionVersion);
    return runAssessment(transaction, agentRuntime, caseRecord, chatInput, sessionId);
  });
}

/** Evidence continuation: bypasses the reset, exactly like "Send Evidence Accepted Message → Get Existing Runtime Results". */
export async function resumeAssessment(repository: Repository, agentRuntime: AgentRuntime, caseRunId: string, sessionId = ''): Promise<AssessmentResult> {
  return repository.transaction(async (transaction) => {
    const caseRecord = await transaction.getCase(caseRunId);
    if (!caseRecord) throw new Error(`CASE_NOT_FOUND:${caseRunId}`);
    const runtimeCase = await transaction.getRuntimeCase(caseRunId);
    // Source "Update row(s)" after EVID-001.
    if (runtimeCase) await transaction.persistRuntimeCase({ ...runtimeCase, status: 'ASSESSMENT_RESUMED', currentStage: 'AGENTIC_REASSESSMENT', targetQueue: 'SBO.02', humanReviewRequired: false, updatedAt: now() });
    return runAssessment(transaction, agentRuntime, caseRecord, `Resume ${caseRunId}`, sessionId);
  });
}

/** Back-compat wrapper used by resubmission and older callers: a fresh evaluation. */
export async function assessCase(repository: Repository, caseRunId: string, sessionId = '', agentRuntime?: AgentRuntime): Promise<AssessmentResult> {
  const { DeterministicAgentRuntime } = await import('@sbo/agent-runtime');
  return evaluateCase(repository, agentRuntime ?? new DeterministicAgentRuntime(), caseRunId, sessionId);
}

export { toolNameFor };
