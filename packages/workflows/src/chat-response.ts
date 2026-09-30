/**
 * "Build Chat Response" (Workflow 03): one clean, customer-facing message.
 * Never exposes prompts, raw tool JSON, rule objects, or debug data. (Source icon glyphs are mojibake in the export; the intended glyphs are used.)
 */
import { type Decision, type ProvisionalRecommendation } from '@sbo/domain';

const checkNameMap: Record<string, string> = { DOCUMENT_EXTRACTION: 'Document checks', BUSINESS_VALIDATION: 'Business validation', IDENTITY_VALIDATION: 'Identity validation', AUTHORITY_VALIDATION: 'Authority validation', SYSTEM_DATA_CHECK: 'System-data checks', FINANCIAL_CHECK: 'Financial checks', FINAL_VERIFICATION: 'Final verification' };
const checkSequenceMap: Record<string, number> = { DOCUMENT_EXTRACTION: 1, BUSINESS_VALIDATION: 2, IDENTITY_VALIDATION: 3, AUTHORITY_VALIDATION: 4, SYSTEM_DATA_CHECK: 5, FINANCIAL_CHECK: 6, FINAL_VERIFICATION: 7 };
const statusMeta: Record<string, { icon: string; label: string; rank: number }> = {
  PASS: { icon: '✓', label: 'Passed', rank: 2 }, PASS_WITH_FLAG: { icon: '△', label: 'Passed with a flag', rank: 3 }, INCONCLUSIVE: { icon: '⚠', label: 'Issue identified', rank: 4 }, FAIL: { icon: '✕', label: 'Failed', rank: 5 }, EXECUTED: { icon: '•', label: 'Executed', rank: 1 }, NOT_RUN: { icon: '–', label: 'Not run', rank: 0 },
};
const outcomeMeta: Record<string, { icon: string; title: string; label: string }> = {
  APPROVE: { icon: '✅', title: 'Eligible to proceed', label: 'APPROVE' }, NEED_MORE_INFORMATION: { icon: '📄', title: 'Additional evidence required', label: 'NEED MORE INFORMATION' }, MANUAL_REVIEW: { icon: '👤', title: 'Specialist review required', label: 'MANUAL REVIEW' }, REJECT: { icon: '⛔', title: 'Unable to proceed', label: 'REJECT' },
};
const reasonTextMap: Record<string, string> = {
  ALL_CHECKS_PASSED: 'All mandatory checks completed successfully.', DOCUMENT_MISSING: 'One or more required documents have not been supplied.', DOCUMENT_UNREADABLE: 'A submitted document cannot be read reliably.', DOCUMENT_CONTRADICTION: 'The submitted documents contain information that requires clarification.', BUSINESS_INACTIVE: 'The business-registration status does not support automated progression.', REGISTRY_UNAVAILABLE: 'The business-register result is unavailable and requires specialist review.', IDENTITY_MISMATCH: 'The submitted identity information does not align with the case details.', AUTHORITY_MISSING: 'The required authority evidence has not been supplied.', AUTHORITY_SCOPE_INSUFFICIENT: 'The submitted authority does not cover every requested permission.', AUTHORITY_SCOPE_AMBIGUOUS: 'The submitted authority does not clearly establish every requested permission.', DUPLICATE_RECORD_CONFLICT: 'Conflicting customer or party records require reconciliation.', ADDITIONAL_EVIDENCE_ACCEPTED: 'The additional evidence resolved the identified gap.', ADDITIONAL_EVIDENCE_INSUFFICIENT: 'The additional evidence does not yet resolve the identified gap.', ADDITIONAL_EVIDENCE_CONTRADICTORY: 'The new evidence conflicts with previously validated case information.', PROMPT_INJECTION_DETECTED: 'A submitted document requires specialist security review.', TBD_POLICY: 'The case requires review by the relevant policy owner.', FINAL_VERIFICATION_FAILED: 'The final required verification did not complete successfully.', CUSTOMER_CONFIRMATION_REQUIRED: 'Customer confirmation is required before the case can continue.', SALES_CONFIRMATION_REQUIRED: 'Sales or account-team confirmation is required before the case can continue.', AGENT_TOOL_RESULTS_MISSING: 'The automated assessment could not be completed and requires operational review.', MANDATORY_CHECKS_INCOMPLETE: 'One or more mandatory validation checks remain incomplete.',
};
const queueLabelMap: Record<string, string> = { ORDER_READINESS: 'Order Readiness', AUTHORITY_REVIEW: 'Authority Review', DATA_RECONCILIATION: 'Customer Data Reconciliation', SECURITY_REVIEW: 'Security Review', POLICY_REVIEW: 'Policy Review', EVIDENCE_REVIEW: 'Evidence Review', AGENT_OPERATIONS_REVIEW: 'Agent Operations Review', CUSTOMER_FOLLOW_UP: 'Customer Follow-up', SBO_02: 'Profiling Operations' };

const titleCaseCode = (value: string): string => String(value || '').trim().replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase());
function canonicalCheckType(value: string): string {
  const upper = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!upper) return '';
  if (upper.includes('DOCUMENT')) return 'DOCUMENT_EXTRACTION';
  if (upper.includes('BUSINESS')) return 'BUSINESS_VALIDATION';
  if (upper.includes('IDENTITY')) return 'IDENTITY_VALIDATION';
  if (upper.includes('AUTHORITY')) return 'AUTHORITY_VALIDATION';
  if (upper.includes('SYSTEM') || upper.includes('CRM') || upper.includes('PARTY_DATA')) return 'SYSTEM_DATA_CHECK';
  if (upper.includes('FINANCIAL') || upper.includes('CREDIT') || upper.includes('BAD_DEBT')) return 'FINANCIAL_CHECK';
  if (upper.includes('FINAL') || upper.includes('COMPLIANCE') || upper.includes('AVCV')) return 'FINAL_VERIFICATION';
  return upper;
}

export interface CuratedChat { output: string; caseRunId: string; governedOutcome: string; primaryReasonCode: string; humanReviewRequired: boolean; }

export function buildChatResponse(input: { decision: Decision; businessName: string; representativeName: string; provisional?: ProvisionalRecommendation; toolsCalled?: string[] }): CuratedChat {
  const { decision } = input;
  const outcome = decision.outcome;
  const display = outcomeMeta[outcome] ?? outcomeMeta.MANUAL_REVIEW!;
  const byType = new Map<string, { checkType: string; status: string; sequence: number }>();
  const replace = (existing: { status: string } | undefined, candidate: { status: string }, existingEvid: boolean, candidateEvid: boolean): boolean => {
    if (candidateEvid && !existingEvid) return true;
    if (existingEvid && !candidateEvid) return false;
    return (statusMeta[candidate.status]?.rank ?? 0) >= (statusMeta[existing?.status ?? '']?.rank ?? 0);
  };
  const evidenceFlag = new Map<string, boolean>();
  decision.completedChecks.forEach((check, index) => {
    const checkType = canonicalCheckType(check.checkType);
    if (!checkType) return;
    const candidate = { checkType, status: check.status.toUpperCase(), sequence: checkSequenceMap[checkType] ?? index + 1 };
    const candidateEvid = check.ruleIds.includes('EVID-001');
    const existing = byType.get(checkType);
    if (!existing || replace(existing, candidate, evidenceFlag.get(checkType) ?? false, candidateEvid)) { byType.set(checkType, candidate); evidenceFlag.set(checkType, candidateEvid); }
  });
  // Defensive presentation fallback from the visible tool trace: shown as "Executed", never as "Passed".
  const traceItems = [...(input.toolsCalled ?? []), ...(input.provisional?.toolsCalled ?? [])];
  traceItems.forEach((item, index) => {
    const checkType = canonicalCheckType(item);
    if (checkType && !byType.has(checkType)) byType.set(checkType, { checkType, status: 'EXECUTED', sequence: checkSequenceMap[checkType] ?? index + 1 });
  });
  const completed = [...byType.values()].sort((left, right) => left.sequence - right.sequence);
  const completedLines = completed.map((check) => {
    const meta = statusMeta[check.status] ?? { icon: '•', label: titleCaseCode(check.status || 'Completed') };
    return `- ${meta.icon} ${checkNameMap[check.checkType] ?? titleCaseCode(check.checkType)} — ${meta.label}`;
  });
  const dedupe = (values: string[]): string[] => { const seen = new Set<string>(); return values.map((value) => value.trim()).filter((value) => value && !seen.has(value.toUpperCase()) && seen.add(value.toUpperCase())); };
  const missing = dedupe(decision.missingInformation);
  const conflicts = dedupe(decision.conflicts);
  const completedTypes = new Set(completed.map((check) => check.checkType));
  const deferred = dedupe(decision.checksNotRun.map(canonicalCheckType).filter((checkType) => checkType && !completedTypes.has(checkType)).map((checkType) => checkNameMap[checkType] ?? titleCaseCode(checkType)));
  const primary = decision.primaryReasonCode.trim().toUpperCase();
  const reasonText = String(reasonTextMap[primary] || decision.customerSafeSummary || conflicts[0] || (primary ? titleCaseCode(primary) : '') || 'The assessment requires further action.').trim();
  const queue = decision.targetQueue.trim().toUpperCase();
  const queueLabel = queue ? (queueLabelMap[queue] ?? titleCaseCode(queue)) : '';
  const sections: string[] = [];
  sections.push(`## ${display.icon} ${display.title}`);
  sections.push(`**Case:** ${decision.caseRunId || 'Not recorded'}  \n**Business:** ${input.businessName || 'Business not recorded'}  \n**Representative:** ${input.representativeName || 'Representative not recorded'}`);
  sections.push(`### Recommendation\n**${display.label}**`);
  sections.push(`### Why\n${reasonText}`);
  if (completedLines.length > 0) sections.push(`### Validation path\n${completedLines.join('\n')}`);
  if (missing.length > 0) sections.push(`### Information required\n${missing.map((item) => `- ${item}`).join('\n')}`);
  if (conflicts.length > 0) sections.push(`### Exceptions identified\n${conflicts.map((item) => `- ${item}`).join('\n')}`);
  if (deferred.length > 0 && primary !== 'AGENT_TOOL_RESULTS_MISSING') sections.push(`### Checks deferred\n${deferred.map((item) => `- ${item}`).join('\n')}`);
  if (queueLabel && (outcome === 'MANUAL_REVIEW' || decision.humanReviewRequired)) sections.push(`### Operational route\n${queueLabel}`);
  sections.push(`### Next step\n${decision.nextAction || 'Await the next operational step.'}`);
  sections.push('---\n*Synthetic prototype. No production-system update or customer communication has been performed.*');
  return { output: sections.join('\n\n'), caseRunId: decision.caseRunId, governedOutcome: outcome, primaryReasonCode: primary, humanReviewRequired: decision.humanReviewRequired };
}
