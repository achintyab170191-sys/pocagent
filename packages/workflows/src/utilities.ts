/**
 * The five specialist utility agents of the To-Be New LOA process (docs/09):
 * SBO.06 Trade License Check · SBO.07 Identity Validation · POA/MOA Check · SBO.09 Bad Debt Check · SBO.10 AVCV Verification.
 *
 * They are deterministic: each reads the documents the customer uploaded in the chat plus the synthetic registers, decides with the pure
 * functions in @sbo/domain, resolves the applicable decision rule, upserts one row keyed by case_run_id + submission_version + check_type
 * and writes a UTILITY_CHECK_COMPLETED audit event. No language model is involved in a check.
 */
import { type CheckContext, type DecisionRule, type DocumentType, type StoredDocument, type UtilityResult, SourceAuditEvents, evaluateLoaCheck, loaCheckCatalog, mandatoryCheckTypes } from '@sbo/domain';
import { type Repository, now, uniqueMillis } from '@sbo/persistence';

export const utilityCatalog = loaCheckCatalog;

export function toolNameFor(checkType: string): string { return utilityCatalog.find((entry) => entry.checkType === checkType.toUpperCase())?.toolName ?? checkType; }

const terminalOutcomes = new Set(['REJECT', 'NEED_MORE_INFORMATION', 'MANUAL_REVIEW']);

export interface UtilityInput { caseRunId: string; submissionVersion: number; checkType: string; }

/** TBD rule → CTRL-001, else first explicit terminal rule, else first applicable rule (priority order). */
export function selectAppliedRule(ruleIds: string[], rules: DecisionRule[]): DecisionRule | undefined {
  const applicable = rules.filter((rule) => ruleIds.includes(rule.ruleId)).sort((left, right) => (left.priority ?? 9999) - (right.priority ?? 9999));
  if (applicable.some((rule) => rule.ruleStatus.toUpperCase() === 'TBD')) {
    const control = rules.find((rule) => rule.ruleId === 'CTRL-001');
    if (!control) throw new Error('CTRL-001 is missing from the decision rules.');
    return control;
  }
  return applicable.find((rule) => terminalOutcomes.has(rule.finalOutcome.toUpperCase())) ?? applicable[0];
}

/** The latest usable document of each type across every evidence request of the case version (a document is data, never instructions). */
export async function loadCaseDocuments(repository: Repository, caseRunId: string, submissionVersion: number): Promise<Partial<Record<DocumentType, StoredDocument>>> {
  const requests = (await repository.getEvidenceRequests(caseRunId)).filter((request) => request.submissionVersion === submissionVersion);
  const records = (await Promise.all(requests.map((request) => repository.getEvidence(request.evidenceRequestId)))).flat()
    .filter((record) => record.evidenceSource === 'FILE_UPLOAD' && !['REJECTED', 'SUPERSEDED'].includes(record.validationStatus))
    .sort((left, right) => left.providedAt.localeCompare(right.providedAt));
  const documents: Partial<Record<DocumentType, StoredDocument>> = {};
  for (const record of records) {
    const type = String(record.structuredData.document_type ?? '') as DocumentType;
    const fields = record.structuredData.fields;
    if (type && fields && typeof fields === 'object') documents[type] = { evidenceId: record.evidenceId, fields: fields as StoredDocument['fields'], text: record.evidenceText };
  }
  return documents;
}

export async function executeUtility(repository: Repository, input: UtilityInput, asOf: Date = new Date()): Promise<UtilityResult> {
  const checkType = input.checkType.toUpperCase();
  const entry = utilityCatalog.find((candidate) => candidate.checkType === checkType);
  if (!entry || !(mandatoryCheckTypes as readonly string[]).includes(checkType)) throw new Error(`UNSUPPORTED_CHECK_TYPE:${input.checkType}`);
  return repository.transaction(async (transaction) => {
    const [caseRecord, rules, documents] = await Promise.all([transaction.getCase(input.caseRunId), transaction.getRules(), loadCaseDocuments(transaction, input.caseRunId, input.submissionVersion)]);
    if (!caseRecord) throw new Error(`CASE_NOT_FOUND:${input.caseRunId}`);
    const context: CheckContext = { businessName: caseRecord.businessName, representativeName: caseRecord.representativeName, asOf, documents };
    const outcome = evaluateLoaCheck(checkType, context);
    const applied = selectAppliedRule(outcome.ruleIds, rules);
    const terminalOutcome = applied?.finalOutcome || 'CONTINUE';
    const row: UtilityResult = {
      resultId: `RES-${input.caseRunId}-V${input.submissionVersion}-${checkType}`,
      caseRunId: input.caseRunId,
      submissionVersion: input.submissionVersion,
      sequence: entry.sequence,
      agentId: entry.agentId,
      utilityName: entry.toolName,
      checkType,
      status: outcome.status,
      findings: outcome.findings,
      reasonCodes: outcome.reasonCodes,
      evidenceReferences: outcome.evidenceReferences,
      confidence: outcome.confidence,
      humanReviewRequired: outcome.humanReviewRequired,
      recommendedNextStep: outcome.recommendedNextStep,
      ruleIds: outcome.ruleIds,
      ruleStatusUsed: applied?.ruleStatus ?? 'CONFIRMED_POC',
      isTerminal: terminalOutcomes.has(terminalOutcome.toUpperCase()),
      terminalOutcome,
      prototypeData: true,
      superseded: false,
      createdAt: now(),
    };
    await transaction.upsertUtilityResult(row);
    await transaction.appendAudit({
      eventId: `EVT-${input.caseRunId}-${row.sequence}-${uniqueMillis()}`,
      caseRunId: input.caseRunId,
      submissionVersion: input.submissionVersion,
      timestamp: now(),
      actor: row.agentId,
      eventType: SourceAuditEvents.UTILITY_CHECK_COMPLETED,
      stage: row.checkType,
      previousState: '',
      newState: row.status,
      ruleId: applied?.ruleId ?? '',
      reasonCode: row.reasonCodes[0] ?? '',
      evidenceReference: row.evidenceReferences.join('; '),
      details: { ...row, appliedRuleId: applied?.ruleId ?? '' },
    });
    return row;
  });
}
