/**
 * Deterministic ports of the seven specialist utility workflows:
 * 05 Document Checks, 06 Business Validation, 07A Identity Validation, 07B Authority Validation,
 * 09 Financial Check, 10 Final Verification, 12 System Data Check.
 *
 * In the source these workflows are deterministic: they read one row of the static fixture table
 * dt_mock_utility_results (Case_Run_ID + Check_Type), resolve the applicable decision rule, upsert the row into
 * dt_utility_results_runtime and write a UTILITY_CHECK_COMPLETED audit event. They contain no language-model step,
 * so they are ported as deterministic functions, not LLM sub-agents.
 */
import { type CheckType, type DecisionRule, type UtilityResult, SourceAuditEvents, mandatoryCheckTypes } from '@sbo/domain';
import { type Repository, now, uniqueMillis } from '@sbo/persistence';

/** Tool names and order taken from the "Prepare Agent Context" mandatorySequence in Workflow 03. */
export const utilityCatalog = [
  { sequence: 1, checkType: 'DOCUMENT_EXTRACTION', toolName: 'Document Checks', workflow: '05 - SBO.05 - Document Checks' },
  { sequence: 2, checkType: 'BUSINESS_VALIDATION', toolName: 'Business Validation', workflow: '06 - SBO.06 - Business Validation' },
  { sequence: 3, checkType: 'IDENTITY_VALIDATION', toolName: 'Identity Validation', workflow: '07A - SBO.07 - Identity Validation' },
  { sequence: 4, checkType: 'AUTHORITY_VALIDATION', toolName: 'Authority Validation', workflow: '07B - SBO.07 - Authority Validation' },
  { sequence: 5, checkType: 'SYSTEM_DATA_CHECK', toolName: 'System Data Check', workflow: '12 - SBO.12 - System Data Check' },
  { sequence: 6, checkType: 'FINANCIAL_CHECK', toolName: 'Financial Check', workflow: '09 - SBO.09 - Financial Check' },
  { sequence: 7, checkType: 'FINAL_VERIFICATION', toolName: 'Final Verification', workflow: '10 - SBO.10 - Final Verification' },
] as const satisfies ReadonlyArray<{ sequence: number; checkType: CheckType; toolName: string; workflow: string }>;

export function toolNameFor(checkType: string): string { return utilityCatalog.find((entry) => entry.checkType === checkType.toUpperCase())?.toolName ?? checkType; }

const terminalOutcomes = new Set(['REJECT', 'NEED_MORE_INFORMATION', 'MANUAL_REVIEW']);

export interface UtilityInput { caseRunId: string; submissionVersion: number; checkType: string; }

/** "Build Utility Result" node: TBD rule → CTRL-001, else first explicit terminal rule, else first applicable rule. */
export function selectAppliedRule(ruleIds: string[], rules: DecisionRule[]): DecisionRule | undefined {
  const applicable = rules.filter((rule) => ruleIds.includes(rule.ruleId)).sort((left, right) => (left.priority ?? 9999) - (right.priority ?? 9999));
  if (applicable.some((rule) => rule.ruleStatus.toUpperCase() === 'TBD')) {
    const control = rules.find((rule) => rule.ruleId === 'CTRL-001');
    if (!control) throw new Error('CTRL-001 is missing from dt_decision_rules.');
    return control;
  }
  return applicable.find((rule) => terminalOutcomes.has(rule.finalOutcome.toUpperCase())) ?? applicable[0];
}

export async function executeUtility(repository: Repository, input: UtilityInput): Promise<UtilityResult> {
  const checkType = input.checkType.toUpperCase();
  if (!(mandatoryCheckTypes as readonly string[]).includes(checkType)) throw new Error(`UNSUPPORTED_CHECK_TYPE:${input.checkType}`);
  return repository.transaction(async (transaction) => {
    const [fixture, rules] = await Promise.all([transaction.getMockResult(input.caseRunId, checkType), transaction.getRules()]);
    const result = fixture ? buildResult(input, checkType, fixture, rules) : unresolvedUtilityResult(input, checkType);
    await transaction.upsertUtilityResult(result.row);
    await transaction.appendAudit({
      eventId: `EVT-${input.caseRunId}-${result.row.sequence}-${uniqueMillis()}`,
      caseRunId: input.caseRunId,
      submissionVersion: input.submissionVersion,
      timestamp: now(),
      actor: result.row.agentId,
      eventType: SourceAuditEvents.UTILITY_CHECK_COMPLETED,
      stage: result.row.checkType,
      previousState: '',
      newState: result.row.status,
      ruleId: result.appliedRuleId,
      reasonCode: result.row.reasonCodes[0] ?? '',
      evidenceReference: result.row.evidenceReferences.join('; '),
      details: { ...result.row, appliedRuleId: result.appliedRuleId },
    });
    return result.row;
  });
}

function buildResult(input: UtilityInput, checkType: string, fixture: NonNullable<Awaited<ReturnType<Repository['getMockResult']>>>, rules: DecisionRule[]): { row: UtilityResult; appliedRuleId: string } {
  const applied = selectAppliedRule(fixture.ruleIds, rules);
  const terminalOutcome = applied?.finalOutcome || 'CONTINUE';
  const row: UtilityResult = {
    resultId: `RES-${input.caseRunId}-${fixture.sequence}`,
    caseRunId: input.caseRunId,
    // Source hard-codes submission_version = 1 in every utility workflow (recorded as a source defect); the target uses the requested version.
    submissionVersion: input.submissionVersion,
    sequence: fixture.sequence,
    agentId: fixture.agentId,
    utilityName: fixture.utilityName,
    // Source stores row.Check_Type verbatim (e.g. AUTH-009: DOCUMENT_EXTRACTION_AND_SECURITY); the ILIKE lookup may return a superset name.
    checkType: fixture.checkType.trim().toUpperCase(),
    status: fixture.status,
    findings: fixture.findings,
    reasonCodes: fixture.reasonCodes,
    evidenceReferences: fixture.evidenceReferences,
    confidence: fixture.confidence,
    humanReviewRequired: fixture.humanReviewRequired,
    recommendedNextStep: fixture.recommendedNextStep,
    ruleIds: fixture.ruleIds,
    ruleStatusUsed: fixture.ruleStatusUsed,
    isTerminal: terminalOutcomes.has(terminalOutcome.toUpperCase()),
    terminalOutcome,
    prototypeData: true,
    superseded: false,
    createdAt: now(),
  };
  return { row, appliedRuleId: applied?.ruleId ?? '' };
}

/** UNRESOLVED_SOURCE_GAP: the fixture has no row for this case/check. Conservative safe result: MANUAL_REVIEW. */
function unresolvedUtilityResult(input: UtilityInput, checkType: string): { row: UtilityResult; appliedRuleId: string } {
  const entry = utilityCatalog.find((candidate) => candidate.checkType === checkType);
  return {
    appliedRuleId: '',
    row: { resultId: `RES-${input.caseRunId}-${entry?.sequence ?? 0}`, caseRunId: input.caseRunId, submissionVersion: input.submissionVersion, sequence: entry?.sequence ?? 0, agentId: 'SBO.02', utilityName: 'Unresolved Source Gap', checkType, status: 'INCONCLUSIVE', findings: { sourceGap: true }, reasonCodes: ['UNRESOLVED_SOURCE_GAP'], evidenceReferences: [], confidence: 0, humanReviewRequired: true, recommendedNextStep: 'Route to manual review because the supplied source fixtures do not define this utility result.', ruleIds: [], ruleStatusUsed: 'UNRESOLVED_SOURCE_GAP', isTerminal: true, terminalOutcome: 'MANUAL_REVIEW', prototypeData: true, superseded: false, createdAt: now() },
  };
}
