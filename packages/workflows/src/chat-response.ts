/**
 * "Build Chat Response" (Workflow 03): one clean, customer-facing message.
 * Never exposes prompts, raw tool JSON, rule objects, or debug data. (Source icon glyphs are mojibake in the export; the intended glyphs are used.)
 */
import { type Decision, type ProvisionalRecommendation } from '@sbo/domain';

const checkNameMap: Record<string, string> = { TRADE_LICENSE_CHECK: 'Trade License and Establishment Card', IDENTITY_VALIDATION: 'Identity (Emirates ID)', POA_MOA_CHECK: 'POA / MOA', BAD_DEBT_CHECK: 'Bad debt and blue-collar', AVCV_VERIFICATION: 'Address and credit verification' };
const checkSequenceMap: Record<string, number> = { TRADE_LICENSE_CHECK: 1, IDENTITY_VALIDATION: 2, POA_MOA_CHECK: 3, BAD_DEBT_CHECK: 4, AVCV_VERIFICATION: 5 };
const statusMeta: Record<string, { icon: string; label: string; rank: number }> = {
  PASS: { icon: '✓', label: 'Passed', rank: 2 }, PASS_WITH_FLAG: { icon: '△', label: 'Passed with a flag', rank: 3 }, INCONCLUSIVE: { icon: '⚠', label: 'Issue identified', rank: 4 }, FAIL: { icon: '⚠', label: 'Under review', rank: 5 }, EXECUTED: { icon: '•', label: 'Executed', rank: 1 }, NOT_RUN: { icon: '–', label: 'Not run', rank: 0 },
};
const outcomeMeta: Record<string, { icon: string; title: string; label: string }> = {
  APPROVE: { icon: '✅', title: 'Eligible to proceed', label: 'APPROVE' }, NEED_MORE_INFORMATION: { icon: '📄', title: 'Additional evidence required', label: 'NEED MORE INFORMATION' }, MANUAL_REVIEW: { icon: '👤', title: 'Specialist review required', label: 'MANUAL REVIEW' }, REJECT: { icon: '🕐', title: 'Awaiting specialist confirmation', label: 'PENDING CONFIRMATION' },
};
const reasonTextMap: Record<string, string> = {
  ALL_CHECKS_PASSED: 'Every check passed: the Trade License, Emirates ID, authority, account history and AVCV are all in order.',
  DOCUMENT_UNREADABLE: 'The Trade License cannot be read reliably.', EID_UNREADABLE: 'The Emirates ID cannot be read reliably.', EID_EXPIRED: 'The Emirates ID has expired.',
  POA_MOA_MISSING: 'You are not the licence owner or an authorised signatory, so a Power of Attorney or Memorandum of Association is required.',
  TRADE_LICENSE_EXPIRED: 'The Trade License has expired.', TRADE_LICENSE_INACTIVE: 'The Trade License is not active.', BUSINESS_NAME_MISMATCH: 'The business name on the request, Trade License and Establishment Card does not match.',
  IDENTITY_MISMATCH: 'The name on the Emirates ID does not match the identity or licence records for this request.', POA_MOA_NOT_CLEARED: 'The Power of Attorney / Memorandum of Association could not be cleared.',
  BAD_DEBT_OBSERVED: 'Outstanding bad debt was found on an account linked to this business or person.', BLUE_COLLAR_OBSERVED: 'Blue-collar behaviour was observed on a linked account.', AVCV_ADVERSE: 'The address or credit verification returned an adverse result.', AVCV_UNVERIFIED: 'The address or credit verification could not be completed, so a specialist will complete it. This is not a failure.', AVCV_DISCREPANCY: 'A discrepancy was found in the address or credit details, so a specialist will review it.', AVCV_INSUFFICIENT_INFORMATION: 'More information is needed to verify the address.', AUTHORITY_LIMITED: 'A limitation is recorded on your authority, so a specialist will review it.',
  LICENSE_NOT_VERIFIABLE: 'The Trade License could not be matched to a licence record, so a specialist will verify it.', IDENTITY_NOT_VERIFIABLE: 'The Emirates ID could not be matched to an identity record, so a specialist will verify it.',
  POA_MOA_NOT_VERIFIABLE: 'The Power of Attorney reference could not be matched, so a specialist will verify it.', 
  ADDITIONAL_EVIDENCE_ACCEPTED: 'The additional documents were received.', ADDITIONAL_EVIDENCE_INSUFFICIENT: 'The documents received do not yet cover everything requested.',
  TBD_POLICY: 'The case requires review by the relevant policy owner.', AGENT_TOOL_RESULTS_MISSING: 'The automated assessment could not be completed and requires operational review.', MANDATORY_CHECKS_INCOMPLETE: 'One or more mandatory validation checks remain incomplete.',
};
const queueLabelMap: Record<string, string> = { ORDER_READINESS: 'Order Readiness', REJECTION_REVIEW: 'Rejection Review', TRADE_LICENSE_REVIEW: 'Trade License Review', IDENTITY_REVIEW: 'Identity Review', POA_MOA_REVIEW: 'POA / MOA Review', AVCV_REVIEW: 'Address and Credit Verification Review', AUTHORITY_REVIEW: 'Authority Review', POLICY_REVIEW: 'Policy Review', EVIDENCE_REVIEW: 'Evidence Review', AGENT_OPERATIONS_REVIEW: 'Agent Operations Review', CUSTOMER_FOLLOW_UP: 'Customer Follow-up' };
const titleCaseCode = (value: string): string => String(value || '').trim().replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase());
function canonicalCheckType(value: string): string {
  const upper = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/\//g, '_');
  if (!upper) return '';
  if (upper.includes('TRADE') || upper.includes('LICENSE')) return 'TRADE_LICENSE_CHECK';
  if (upper.includes('IDENTITY')) return 'IDENTITY_VALIDATION';
  if (upper.includes('POA') || upper.includes('MOA')) return 'POA_MOA_CHECK';
  if (upper.includes('BAD_DEBT')) return 'BAD_DEBT_CHECK';
  if (upper.includes('AVCV')) return 'AVCV_VERIFICATION';
  return upper;
}
/** Customer-safe explanation for a reason code. */
export function customerReason(reasonCode: string): string { return reasonTextMap[reasonCode.trim().toUpperCase()] ?? ''; }

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
  // A recommended rejection is never communicated externally: only a human can confirm it (docs/09).
  const pendingRejection = outcome === 'REJECT';
  const reasonText = pendingRejection ? 'Our checks found an issue that a specialist must review before any decision is made. Nothing has been communicated as a final decision.' : String(reasonTextMap[primary] || decision.customerSafeSummary || conflicts[0] || (primary ? titleCaseCode(primary) : '') || 'The assessment requires further action.').trim();
  const queue = decision.targetQueue.trim().toUpperCase();
  const queueLabel = queue ? (queueLabelMap[queue] ?? titleCaseCode(queue)) : '';
  const sections: string[] = [];
  sections.push(`## ${display.icon} ${display.title}`);
  sections.push(`**Case:** ${decision.caseRunId || 'Not recorded'}  \n**Business:** ${input.businessName || 'Business not recorded'}  \n**Representative:** ${input.representativeName || 'Representative not recorded'}`);
  sections.push(`### Recommendation\n**${display.label}**`);
  sections.push(`### Why\n${reasonText}`);
  if (completedLines.length > 0) sections.push(`### Validation path\n${completedLines.join('\n')}`);
  if (missing.length > 0) sections.push(`### Information required\n${missing.map((item) => `- ${item}`).join('\n')}`);
  if (conflicts.length > 0 && !pendingRejection) sections.push(`### Exceptions identified\n${conflicts.map((item) => `- ${item}`).join('\n')}`);
  if (deferred.length > 0 && primary !== 'AGENT_TOOL_RESULTS_MISSING') sections.push(`### Checks deferred\n${deferred.map((item) => `- ${item}`).join('\n')}`);
  if (queueLabel && !pendingRejection && (outcome === 'MANUAL_REVIEW' || decision.humanReviewRequired)) sections.push(`### Operational route\n${queueLabel}`);
  sections.push(`### Next step\n${pendingRejection ? 'A specialist will review the findings and confirm the decision. You will be contacted.' : decision.nextAction || 'Await the next operational step.'}`);
  sections.push('---\n*Synthetic prototype. No production-system update or customer communication has been performed.*');
  return { output: sections.join('\n\n'), caseRunId: decision.caseRunId, governedOutcome: outcome, primaryReasonCode: primary, humanReviewRequired: decision.humanReviewRequired };
}
