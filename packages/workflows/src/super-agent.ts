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
  type CaseRecord, type Decision, type EvidenceRequest, type HumanReview, type ProvisionalRecommendation, type RuntimeCase, type UtilityResult, type Communication,
  TargetAuditEvents, buildRootCauseAnalysis, documentLabels, mandatoryCheckTypes,
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

/** Runtime-case status of a version that a human reviewer reopened as a newer version (docs/09, review dashboard). */
export const reopenedStatus = 'REOPENED_AS_NEW_VERSION';
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

export interface ContinuationConfig { remediable: boolean; channel: string; checkType: string; requestedItems: string[]; /** What the customer is told when the request opens (defaults to the list of requested items). */ message?: string; }

/** Which findings the customer can fix by attaching a document (NEED_MORE_INFORMATION); everything else goes to a human reviewer. */
export function classifyContinuation(decision: Pick<Decision, 'outcome' | 'primaryReasonCode' | 'missingInformation'> & { conflicts?: string[] }): ContinuationConfig {
  // An authority document that was read but does not satisfy the request: the customer is told exactly what is missing and uploads a revised one.
  const authorityGaps = (decision.conflicts ?? []).filter(Boolean);
  // A supporting document was read and its details are missing or inconsistent: the same check asks for a corrected one, naming the problems.
  const replaceTypes = (decision.missingInformation ?? []).filter((item): item is keyof typeof documentLabels => item in documentLabels);
  const detailsRequest = (checkType: string, fallback: keyof typeof documentLabels, what: string): ContinuationConfig => ({ remediable: true, channel: 'FILE_UPLOAD', checkType, requestedItems: (replaceTypes.length > 0 ? replaceTypes : [fallback]).map((type) => documentLabels[type]), message: `I read the ${what} you provided, and it is not enough yet:\n\n${authorityGaps.map((gap) => `- ${gap}`).join('\n')}\n\nPlease attach a corrected ${what}.` });
  const authorityRequest: ContinuationConfig = { remediable: true, channel: 'FILE_UPLOAD', checkType: 'POA_MOA_CHECK', requestedItems: ['A revised authority letter or Power of Attorney / Memorandum of Association'], message: `I read the authority document you provided, and it is not enough yet:\n\n${authorityGaps.map((gap) => `- ${gap}`).join('\n')}\n\nPlease attach a revised authority letter or Power of Attorney / Memorandum of Association that fixes this.` };
  const table: Record<string, ContinuationConfig> = {
    DOCUMENT_UNREADABLE: { remediable: true, channel: 'FILE_UPLOAD', checkType: 'TRADE_LICENSE_CHECK', requestedItems: [documentLabels.TRADE_LICENSE] },
    EID_UNREADABLE: { remediable: true, channel: 'FILE_UPLOAD', checkType: 'IDENTITY_VALIDATION', requestedItems: [documentLabels.EMIRATES_ID] },
    EID_EXPIRED: { remediable: true, channel: 'FILE_UPLOAD', checkType: 'IDENTITY_VALIDATION', requestedItems: ['A valid (unexpired) Emirates ID of the representative'] },
    TRADE_LICENSE_DETAILS_INSUFFICIENT: detailsRequest('TRADE_LICENSE_CHECK', 'TRADE_LICENSE', 'Trade License / Establishment Card'),
    EID_DETAILS_INSUFFICIENT: detailsRequest('IDENTITY_VALIDATION', 'EMIRATES_ID', 'Emirates ID'),
    ADDRESS_PROOF_INSUFFICIENT: detailsRequest('AVCV_VERIFICATION', 'ADDRESS_PROOF', 'proof of address'),
    AUTHORITY_SCOPE_INSUFFICIENT: authorityRequest,
    AUTHORITY_DETAILS_MISMATCH: authorityRequest,
    POA_MOA_MISSING: { remediable: true, channel: 'FILE_UPLOAD', checkType: 'POA_MOA_CHECK', requestedItems: [documentLabels.POA_MOA] },
    AVCV_INSUFFICIENT_INFORMATION: { remediable: true, channel: 'FILE_UPLOAD', checkType: 'AVCV_VERIFICATION', requestedItems: [documentLabels.ADDRESS_PROOF] },
  };
  const reason = decision.primaryReasonCode.trim().toUpperCase();
  return table[reason] ?? { remediable: false, channel: decision.outcome === 'NEED_MORE_INFORMATION' ? 'FILE_UPLOAD' : 'HUMAN_REVIEW', checkType: 'DOCUMENT_INTAKE', requestedItems: [] };
}

export interface EvidenceRequestInput { caseRunId: string; submissionVersion: number; sessionId: string; originatingCheckType: string; reasonCode: string; requestedItems: string[]; previousState: string; ruleId?: string; message?: string; }

/** Opens an evidence request and puts the case in WAITING_FOR_EVIDENCE (creating the runtime case record if this is the very first request). */
export async function openEvidenceRequest(repository: Repository, input: EvidenceRequestInput): Promise<EvidenceRequest> {
  // One clock read: created_at and due_at (+48 h) come from the same instant.
  const createdMillis = Date.now();
  const timestamp = new Date(createdMillis).toISOString();
  const request: EvidenceRequest = {
    evidenceRequestId: `EVID-${input.caseRunId}-V${input.submissionVersion}-${uniqueMillis()}`,
    caseRunId: input.caseRunId,
    submissionVersion: input.submissionVersion,
    sessionId: input.sessionId,
    processCode: 'P-1.1',
    originatingCheckType: input.originatingCheckType,
    originatingReasonCode: input.reasonCode,
    evidenceChannel: 'FILE_UPLOAD',
    requestedItems: input.requestedItems,
    customerMessage: input.message ?? (input.requestedItems.length > 0 ? `Please attach the following document(s):\n${input.requestedItems.map((item) => `- ${item}`).join('\n')}` : 'Please attach the document needed to continue.'),
    status: 'OPEN',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: timestamp,
    dueAt: new Date(createdMillis + 48 * 60 * 60 * 1000).toISOString(),
  };
  await repository.transaction(async (transaction) => {
    await transaction.persistEvidenceRequest(request);
    const caseRecord = await transaction.getCase(input.caseRunId);
    const existing = await transaction.getRuntimeCase(input.caseRunId);
    const base: RuntimeCase | undefined = existing ?? (caseRecord ? { caseRunId: caseRecord.caseRunId, caseId: caseRecord.caseId, submissionVersion: caseRecord.submissionVersion, country: caseRecord.country, requestType: caseRecord.requestType, businessName: caseRecord.businessName, businessIdentifier: caseRecord.businessIdentifier, customerId: caseRecord.customerId, representativeName: caseRecord.representativeName, status: '', currentStage: '', finalOutcome: '', targetQueue: '', humanReviewRequired: false, createdAt: timestamp, updatedAt: timestamp, primaryReasonCode: '' } : undefined);
    if (base) await transaction.persistRuntimeCase({ ...base, status: 'WAITING_FOR_EVIDENCE', currentStage: 'CUSTOMER_EVIDENCE', targetQueue: 'CUSTOMER_FOLLOW_UP', humanReviewRequired: false, updatedAt: now() });
    await transaction.appendAudit({ eventId: `EVT-${input.caseRunId}-EVIDENCE-REQUEST-${uniqueMillis()}`, caseRunId: input.caseRunId, submissionVersion: input.submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: TargetAuditEvents.EVIDENCE_REQUESTED, stage: 'EVIDENCE_COLLECTION', previousState: input.previousState, newState: 'WAITING_FOR_EVIDENCE', ruleId: input.ruleId ?? '', reasonCode: input.reasonCode, evidenceReference: request.evidenceRequestId, details: { evidenceChannel: request.evidenceChannel, requestedItems: request.requestedItems, originatingCheckType: request.originatingCheckType } });
  });
  return request;
}

export async function createEvidenceRequest(repository: Repository, decision: Decision, config: ContinuationConfig, sessionId: string): Promise<EvidenceRequest> {
  return openEvidenceRequest(repository, { caseRunId: decision.caseRunId, submissionVersion: decision.submissionVersion, sessionId, originatingCheckType: config.checkType, reasonCode: decision.primaryReasonCode, requestedItems: config.requestedItems, previousState: decision.outcome, ruleId: decision.appliedRuleId, message: config.message });
}
/**
 * A MANUAL_REVIEW or REJECT decision creates a review row (REV-{case}-{n}) on the review dashboard; a rejection stays pending until a human confirms it.
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

/** SBO.20 RCA agent: a rejection triggers a root-cause analysis (deterministic summary here), recorded on the audit trail for the reviewer. */
export async function requestRootCauseAnalysis(repository: Repository, decision: Decision): Promise<void> {
  const failed = decision.completedChecks.find((check) => check.status.toUpperCase() === 'FAIL');
  const analysis = buildRootCauseAnalysis(decision.primaryReasonCode, failed?.checkType ?? '');
  await repository.appendAudit({ eventId: `EVT-${decision.caseRunId}-RCA-${uniqueMillis()}`, caseRunId: decision.caseRunId, submissionVersion: decision.submissionVersion, timestamp: now(), actor: 'SBO.20', eventType: TargetAuditEvents.RCA_REQUESTED, stage: 'ROOT_CAUSE_ANALYSIS', previousState: '', newState: 'RCA_COMPLETED', ruleId: decision.appliedRuleId, reasonCode: decision.primaryReasonCode, evidenceReference: decision.decisionId, details: { ...analysis } });
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
  if (decision.outcome === 'REJECT') await requestRootCauseAnalysis(repository, decision);
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
    if (reviews.some((review) => review.reviewStatus.toUpperCase() === 'COMPLETED') || runtimeCase?.status === reopenedStatus) throw new Error(`CASE_LOCKED:${caseRecord.caseRunId}`);
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

export { toolNameFor };

