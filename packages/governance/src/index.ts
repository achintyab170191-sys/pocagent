/**
 * Workflow 90 — Finalize Decision. Deterministic port; this module never calls a language model.
 * Node mapping is recorded in docs/05-n8n-to-code-traceability.md.
 */
import {
  type CaseRecord,
  type Communication,
  type CommunicationTemplate,
  type Decision,
  type DecisionRule,
  type GovernedOutcome,
  type RuntimeCase,
  type UtilityResult,
  TargetAuditEvents,
  mandatoryCheckTypes,
  normalizeOutcome,
} from '@sbo/domain';
import { type Repository, now, uniqueMillis } from '@sbo/persistence';

export type ResultSource = 'MOCK' | 'RUNTIME';
export type CheckRow = Pick<UtilityResult, 'sequence' | 'agentId' | 'utilityName' | 'checkType' | 'status' | 'findings' | 'reasonCodes' | 'ruleIds'>;

const terminalOutcomes = ['REJECT', 'NEED_MORE_INFORMATION', 'MANUAL_REVIEW'];

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }

/** "Determine Final Decision" → customer_safe_summary switch. */
function customerSafeSummary(outcome: string): string {
  switch (outcome) {
    case 'APPROVE': return 'The prototype assessment completed all mandatory checks successfully. The request is eligible to proceed to the next operational step.';
    case 'NEED_MORE_INFORMATION': return 'The assessment cannot be completed until the requested information is supplied.';
    case 'MANUAL_REVIEW': return 'The assessment identified information that requires review by an operations specialist. No final adverse decision has been made.';
    case 'REJECT': return 'The prototype identified a condition that prevents automated progression. Human confirmation is required before final disposition.';
    default: return 'The assessment requires further processing.';
  }
}

function conflictSummary(checks: CheckRow[]): string[] {
  const conflicts: string[] = [];
  for (const check of checks) {
    const findings = check.findings;
    if (findings.legal_name_conflict === true) conflicts.push('Conflicting legal names exist across CRM records.');
    if (findings.open_duplicate_request === true) conflicts.push('Another authority request is already open.');
    if (String(findings.scope).toUpperCase() === 'AMBIGUOUS') conflicts.push('The submitted authority scope is ambiguous.');
    if (findings.security_flag && String(findings.security_flag).toUpperCase() !== 'NONE') conflicts.push('A document security flag requires specialist review.');
    if (String(findings.lookup_status).toUpperCase() === 'UNAVAILABLE') conflicts.push('The business-register lookup is unavailable.');
  }
  return unique(conflicts);
}

function missingInformationFor(checks: CheckRow[], applicableRules: DecisionRule[]): string[] {
  const missing: string[] = [];
  for (const check of checks) {
    const value = check.findings.missing;
    if (Array.isArray(value)) missing.push(...(value as string[]));
  }
  if (applicableRules.some((rule) => rule.reasonCode === 'AUTHORITY_MISSING') && !missing.includes('AUTHORITY_LETTER')) missing.push('AUTHORITY_LETTER');
  return unique(missing);
}

export interface Determination { decision: Decision; selectedRule: DecisionRule; }

/** Pure port of the "Determine Final Decision" code node. */
export function determineDecision(caseRecord: CaseRecord, rows: CheckRow[], rules: DecisionRule[], resultSource: ResultSource, createdAt = now()): Decision {
  const rulesById = new Map(rules.map((rule) => [rule.ruleId.trim(), rule]));
  const checks = rows.map((row) => ({ ...row, checkType: row.checkType.trim().toUpperCase(), status: row.status.trim().toUpperCase() }));
  const observedCompleted = new Set(checks.filter((check) => check.status !== 'NOT_RUN').map((check) => check.checkType));
  const explicitNotRun = checks.filter((check) => check.status === 'NOT_RUN').map((check) => check.checkType);
  const absentMandatory = mandatoryCheckTypes.filter((checkType) => !observedCompleted.has(checkType));
  const referenced = unique(checks.flatMap((check) => check.ruleIds));
  const applicable = referenced.map((id) => rulesById.get(id)).filter((rule): rule is DecisionRule => Boolean(rule)).sort((left, right) => (left.priority ?? 9999) - (right.priority ?? 9999));
  const tbdRule = applicable.find((rule) => rule.ruleStatus.toUpperCase() === 'TBD');
  let governanceControlApplied = false;
  let selected: DecisionRule | undefined;
  const require = (ruleId: string): DecisionRule => {
    const rule = rulesById.get(ruleId);
    if (!rule) throw new Error(`${ruleId} is missing from dt_decision_rules.`);
    return rule;
  };
  if (resultSource === 'RUNTIME' && checks.length === 0) {
    selected = require('CTRL-002');
    governanceControlApplied = true;
  } else if (tbdRule) {
    selected = require('CTRL-001');
    governanceControlApplied = true;
  } else {
    selected = applicable.find((rule) => terminalOutcomes.includes(rule.finalOutcome.toUpperCase()));
  }
  if (!selected) {
    // Target-only safety net: a utility with no fixture row (UNRESOLVED_SOURCE_GAP) must never reach the source's "Approval blocked" throw.
    const sourceGap = checks.some((check) => check.findings.sourceGap === true);
    if ((resultSource === 'RUNTIME' && absentMandatory.length > 0) || sourceGap) {
      selected = require('CTRL-003');
      governanceControlApplied = true;
    } else {
      const successful = new Set(checks.filter((check) => ['PASS', 'PASS_WITH_FLAG'].includes(check.status)).map((check) => check.checkType));
      const failedCompleteness = mandatoryCheckTypes.filter((checkType) => !successful.has(checkType));
      if (failedCompleteness.length > 0) throw new Error(`Approval blocked. Mandatory checks incomplete: ${failedCompleteness.join(', ')}`);
      selected = require('FINAL-001');
    }
  }
  const outcome = normalizeOutcome(selected.finalOutcome);
  return {
    decisionId: `DEC-${caseRecord.caseRunId}-${caseRecord.submissionVersion}`,
    caseRunId: caseRecord.caseRunId,
    caseId: caseRecord.caseId,
    submissionVersion: caseRecord.submissionVersion,
    resultSource,
    outcome,
    primaryReasonCode: selected.reasonCode,
    secondaryReasonCodes: unique(checks.flatMap((check) => check.reasonCodes)),
    targetQueue: selected.targetQueue,
    missingInformation: missingInformationFor(checks, applicable),
    conflicts: conflictSummary(checks),
    nextAction: selected.nextAction,
    customerSafeSummary: customerSafeSummary(selected.finalOutcome.toUpperCase()),
    internalSummary: `Applied ${selected.ruleId}${governanceControlApplied ? ' (governance control)' : ''}; ${checks.length} current utility result(s).`,
    communicationTemplateId: selected.communicationTemplateId,
    appliedRuleId: selected.ruleId,
    appliedRuleStatus: selected.ruleStatus,
    governanceControlApplied,
    triggeringTbdRule: tbdRule ? tbdRule.ruleId : null,
    assumptionsUsed: applicable.filter((rule) => rule.ruleStatus.toUpperCase() === 'ASSUMPTION').map((rule) => rule.ruleId),
    completedChecks: checks.filter((check) => check.status !== 'NOT_RUN').map((check) => ({ sequence: check.sequence, agentId: check.agentId, utilityName: check.utilityName, checkType: check.checkType, status: check.status, reasonCodes: check.reasonCodes, ruleIds: check.ruleIds })),
    humanReviewRequired: selected.humanReviewRequired,
    checksNotRun: unique([...explicitNotRun, ...(resultSource === 'RUNTIME' ? absentMandatory : [])]),
    prototypeData: true,
    productionWritePerformed: false,
    createdAt,
  };
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (values[key] !== undefined ? values[key] : whole));
}

/** "Build Communication" node. Communications are drafts and are never sent. */
export function renderCommunication(caseRecord: CaseRecord, decision: Decision, template: CommunicationTemplate, createdAt = now()): Communication {
  const values = {
    case_id: decision.caseRunId,
    business_name: caseRecord.businessName,
    representative_name: caseRecord.representativeName,
    outcome: decision.outcome,
    reason_code: decision.primaryReasonCode,
    queue: decision.targetQueue,
    next_action: decision.nextAction,
    missing_items: decision.missingInformation.length > 0 ? decision.missingInformation.join(', ') : 'None',
  };
  return { communicationId: `COMM-${decision.caseRunId}-V${decision.submissionVersion}-INITIAL`, caseRunId: decision.caseRunId, audience: template.audience, templateId: template.templateId, subject: fillTemplate(template.subjectTemplate, values), body: fillTemplate(template.bodyTemplate, values), status: 'DRAFT', approvalRequired: true, sent: false, createdAt };
}

const statusMap: Record<GovernedOutcome, string> = { APPROVE: 'READY_TO_PROCEED', NEED_MORE_INFORMATION: 'WAITING_FOR_INFORMATION', MANUAL_REVIEW: 'REVIEW_PENDING', REJECT: 'REJECTION_CONFIRMATION_PENDING' };
const stageMap: Record<GovernedOutcome, string> = { APPROVE: 'DECISION_COMPLETE', NEED_MORE_INFORMATION: 'CUSTOMER_ACTION', MANUAL_REVIEW: 'HUMAN_REVIEW', REJECT: 'HUMAN_CONFIRMATION' };

/** "Prepare Runtime Case Record" node. */
export function createRuntimeCase(caseRecord: CaseRecord, decision: Decision): RuntimeCase {
  const timestamp = now();
  return { caseRunId: caseRecord.caseRunId, caseId: caseRecord.caseId, submissionVersion: caseRecord.submissionVersion, country: caseRecord.country, requestType: caseRecord.requestType, businessName: caseRecord.businessName, businessIdentifier: caseRecord.businessIdentifier, customerId: caseRecord.customerId, representativeName: caseRecord.representativeName, status: statusMap[decision.outcome], currentStage: stageMap[decision.outcome], finalOutcome: decision.outcome, targetQueue: decision.targetQueue, humanReviewRequired: decision.humanReviewRequired, createdAt: timestamp, updatedAt: timestamp, primaryReasonCode: decision.primaryReasonCode };
}

export async function loadRowsForSource(repository: Repository, caseRunId: string, submissionVersion: number, resultSource: ResultSource): Promise<CheckRow[]> {
  if (resultSource === 'MOCK') return (await repository.getMockResults(caseRunId)).map((row) => ({ sequence: row.sequence, agentId: row.agentId, utilityName: row.utilityName, checkType: row.checkType, status: row.status, findings: row.findings, reasonCodes: row.reasonCodes, ruleIds: row.ruleIds }));
  return repository.getRuntimeResults(caseRunId, submissionVersion);
}

export function parseResultSource(value: string | undefined): ResultSource {
  const normalized = String(value || 'MOCK').trim().toUpperCase();
  if (normalized === 'MOCK' || normalized === 'RUNTIME') return normalized;
  throw new Error(`Unsupported result source: ${normalized}. Use MOCK or RUNTIME.`);
}

/**
 * Workflow 90 end-to-end: decision, draft communication, runtime case and audit are written in one transaction.
 * Persisted runtime results MUST exist before this is called (checked implicitly: RUNTIME with no rows → CTRL-002).
 */
export async function finalizeDecision(repository: Repository, caseRunId: string, submissionVersion: number, resultSource: ResultSource = 'RUNTIME'): Promise<{ decision: Decision; communication: Communication }> {
  return repository.transaction(async (transaction) => {
    const caseRecord = await transaction.getCase(caseRunId);
    if (!caseRecord) throw new Error(`CASE_NOT_FOUND:${caseRunId}`);
    const [rules, rows] = await Promise.all([transaction.getRules(), loadRowsForSource(transaction, caseRunId, submissionVersion, resultSource)]);
    const decision = determineDecision(caseRecord, rows, rules, resultSource);
    const template = await transaction.getTemplate(decision.communicationTemplateId);
    if (!template) throw new Error(`COMMUNICATION_TEMPLATE_NOT_FOUND:${decision.communicationTemplateId}`);
    const communication = renderCommunication(caseRecord, decision, template);
    const previous = await transaction.getRuntimeCase(caseRunId);
    const runtimeCase = createRuntimeCase(caseRecord, decision);
    await transaction.persistDecision(decision);
    await transaction.persistCommunication(communication);
    await transaction.persistRuntimeCase(runtimeCase);
    const stamp = uniqueMillis();
    await transaction.appendAudit({ eventId: `EVT-${caseRunId}-DECISION-${stamp}`, caseRunId, submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: TargetAuditEvents.DECISION_GENERATED, stage: 'FINALIZATION', previousState: previous?.status ?? 'ASSESSMENT_IN_PROGRESS', newState: decision.outcome, ruleId: decision.appliedRuleId, reasonCode: decision.primaryReasonCode, evidenceReference: decision.decisionId, details: { decisionId: decision.decisionId, resultSource, resultCount: rows.length, governanceControlApplied: decision.governanceControlApplied } });
    await transaction.appendAudit({ eventId: `EVT-${caseRunId}-COMMUNICATION-${stamp}`, caseRunId, submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: TargetAuditEvents.COMMUNICATION_DRAFTED, stage: 'COMMUNICATION', previousState: '', newState: 'DRAFT', ruleId: decision.appliedRuleId, reasonCode: decision.primaryReasonCode, evidenceReference: communication.communicationId, details: { templateId: template.templateId, sent: false } });
    await transaction.appendAudit({ eventId: `EVT-${caseRunId}-STATE-${stamp}`, caseRunId, submissionVersion, timestamp: now(), actor: 'SBO.02', eventType: TargetAuditEvents.CASE_STATE_CHANGED, stage: 'FINALIZATION', previousState: previous?.status ?? 'INITIAL', newState: runtimeCase.status, ruleId: decision.appliedRuleId, reasonCode: decision.primaryReasonCode, evidenceReference: '', details: { currentStage: runtimeCase.currentStage, targetQueue: runtimeCase.targetQueue } });
    return { decision, communication };
  });
}
