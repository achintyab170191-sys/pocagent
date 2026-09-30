import { z } from 'zod';

import { loaCheckCatalog } from './loa.js';

/** The five mandatory checks of the To-Be New LOA process, in governed order (docs/09). */
export const mandatoryCheckTypes = loaCheckCatalog.map((entry) => entry.checkType) as unknown as readonly ['TRADE_LICENSE_CHECK', 'IDENTITY_VALIDATION', 'POA_MOA_CHECK', 'BAD_DEBT_CHECK', 'AVCV_VERIFICATION'];

export type CheckType = (typeof mandatoryCheckTypes)[number] | 'DOCUMENT_INTAKE';
export const governedOutcomes = ['APPROVE', 'REJECT', 'NEED_MORE_INFORMATION', 'MANUAL_REVIEW'] as const;
export type GovernedOutcome = (typeof governedOutcomes)[number];

export const CaseRecordSchema = z.object({
  caseRunId: z.string().min(1),
  caseId: z.string().min(1),
  submissionVersion: z.number().int().positive(),
  country: z.string(),
  requestType: z.string(),
  channel: z.string(),
  businessName: z.string(),
  businessIdentifier: z.string(),
  customerId: z.string(),
  representativeName: z.string(),
  representativeRole: z.string(),
  requestedAuthority: z.string(),
  requestNarrative: z.string(),
  documentsSubmitted: z.string(),
  submittedAt: z.string(),
  processingPriority: z.string(),
  syntheticOnly: z.boolean(),
});
export type CaseRecord = z.infer<typeof CaseRecordSchema>;

export const DecisionRuleSchema = z.object({
  priority: z.number(),
  ruleId: z.string(),
  stage: z.string(),
  condition: z.string(),
  requiredEvidence: z.string(),
  utilityAgent: z.string(),
  checkResult: z.string(),
  finalOutcome: z.string(),
  reasonCode: z.string(),
  humanReviewRequired: z.boolean(),
  nextAction: z.string(),
  targetQueue: z.string(),
  communicationTemplateId: z.string(),
  ruleOwner: z.string(),
  ruleStatus: z.string(),
  notes: z.string(),
});
export type DecisionRule = z.infer<typeof DecisionRuleSchema>;

export const UtilityResultSchema = z.object({
  resultId: z.string().min(1),
  caseRunId: z.string().min(1),
  submissionVersion: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  agentId: z.string(),
  utilityName: z.string(),
  checkType: z.string().min(1),
  status: z.string().min(1),
  findings: z.record(z.string(), z.unknown()),
  reasonCodes: z.array(z.string()),
  evidenceReferences: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  humanReviewRequired: z.boolean(),
  recommendedNextStep: z.string(),
  ruleIds: z.array(z.string()),
  ruleStatusUsed: z.string(),
  isTerminal: z.boolean(),
  terminalOutcome: z.string(),
  prototypeData: z.literal(true),
  superseded: z.boolean().default(false),
  createdAt: z.string().datetime(),
  evidenceRequestId: z.string().optional(),
});
export type UtilityResult = z.infer<typeof UtilityResultSchema>;

export const ProvisionalRecommendationSchema = z.object({
  caseRunId: z.string(),
  toolsCalled: z.array(z.string()),
  provisionalOutcome: z.enum(governedOutcomes),
  evidenceSummary: z.array(z.string()),
  missingInformation: z.array(z.string()),
  conflicts: z.array(z.string()),
  humanReviewRequired: z.boolean(),
  nextAction: z.string(),
  decisionRationale: z.string(),
  confidence: z.number().min(0).max(1),
});
export type ProvisionalRecommendation = z.infer<typeof ProvisionalRecommendationSchema>;

export const CompletedCheckSchema = z.object({
  sequence: z.number(),
  agentId: z.string(),
  utilityName: z.string(),
  checkType: z.string(),
  status: z.string(),
  reasonCodes: z.array(z.string()),
  ruleIds: z.array(z.string()),
});
export type CompletedCheck = z.infer<typeof CompletedCheckSchema>;

export const DecisionSchema = z.object({
  decisionId: z.string().min(1),
  caseRunId: z.string().min(1),
  caseId: z.string().min(1),
  submissionVersion: z.number().int().positive(),
  resultSource: z.enum(['MOCK', 'RUNTIME']).default('RUNTIME'),
  outcome: z.enum(governedOutcomes),
  primaryReasonCode: z.string().min(1),
  secondaryReasonCodes: z.array(z.string()),
  targetQueue: z.string(),
  missingInformation: z.array(z.string()),
  conflicts: z.array(z.string()),
  nextAction: z.string(),
  customerSafeSummary: z.string(),
  internalSummary: z.string(),
  communicationTemplateId: z.string(),
  appliedRuleId: z.string(),
  appliedRuleStatus: z.string(),
  governanceControlApplied: z.boolean().default(false),
  triggeringTbdRule: z.string().nullable().default(null),
  assumptionsUsed: z.array(z.string()).default([]),
  completedChecks: z.array(CompletedCheckSchema).default([]),
  humanReviewRequired: z.boolean(),
  checksNotRun: z.array(z.string()),
  prototypeData: z.literal(true),
  productionWritePerformed: z.literal(false),
  createdAt: z.string().datetime(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** Audit event names exactly as written by the n8n workflows. Target-only additions are listed separately. */
export const SourceAuditEvents = {
  UTILITY_CHECK_COMPLETED: 'UTILITY_CHECK_COMPLETED',
  ADDITIONAL_EVIDENCE_RECEIVED: 'ADDITIONAL_EVIDENCE_RECEIVED',
  ADDITIONAL_EVIDENCE_REQUIRED: 'ADDITIONAL_EVIDENCE_REQUIRED',
  EVIDENCE_REQUEST_CANCELLED: 'EVIDENCE_REQUEST_CANCELLED',
  EVIDENCE_REVIEW_QUEUED: 'EVIDENCE_REVIEW_QUEUED',
  CONTRADICTORY_EVIDENCE_ESCALATED: 'CONTRADICTORY_EVIDENCE_ESCALATED',
  HUMAN_REVIEW_COMPLETED: 'HUMAN_REVIEW_COMPLETED',
  CASE_RESUBMITTED: 'CASE_RESUBMITTED',
} as const;

/** Audit events the n8n export does not write but the migration brief requires for material transitions. */
export const TargetAuditEvents = {
  ASSESSMENT_STARTED: 'ASSESSMENT_STARTED',
  ASSESSMENT_RESUMED: 'ASSESSMENT_RESUMED',
  DECISION_GENERATED: 'DECISION_GENERATED',
  COMMUNICATION_DRAFTED: 'COMMUNICATION_DRAFTED',
  CASE_STATE_CHANGED: 'CASE_STATE_CHANGED',
  EVIDENCE_REQUESTED: 'EVIDENCE_REQUESTED',
  REVIEW_CREATED: 'REVIEW_CREATED',
  RCA_REQUESTED: 'RCA_REQUESTED',
  REQUEST_CAPTURED: 'REQUEST_CAPTURED',
  CASE_REOPENED: 'CASE_REOPENED',
} as const;

export const EvidenceRequestStatuses = ['OPEN', 'RECEIVED', 'PARTIALLY_RECEIVED', 'INSUFFICIENT', 'ACCEPTED', 'ESCALATED', 'CANCELLED'] as const;
export type EvidenceRequestStatus = (typeof EvidenceRequestStatuses)[number];

/**
 * Details collected in the opening conversation before a case exists (target-side intake adapter, docs/07 G-32 — the n8n chat starts from a
 * known Case Run ID). Free text from the customer: untrusted, length-limited, never used to select behaviour except scenario matching.
 */
export const IntakeDetailsSchema = z.object({
  representativeName: z.string().max(120).default(''),
  businessName: z.string().max(160).default(''),
  businessIdentifier: z.string().max(60).default(''),
});
export type IntakeDetails = z.infer<typeof IntakeDetailsSchema>;

/**
 * IDLE: no open conversation step · INTAKE: collecting name / company · AWAITING_EVIDENCE: an evidence request is open and the customer can
 * answer with text and/or attached documents in the same window · DONE: assessment finished.
 * (The source's TEXT/UPLOAD method choice and "UPLOADED" acknowledgement are gone — docs/07 G-31.)
 */
export const ChatSessionStateSchema = z.object({
  sessionId: z.string(),
  caseRunId: z.string(),
  step: z.enum(['IDLE', 'INTAKE', 'AWAITING_EVIDENCE', 'DONE']),
  evidenceRequestId: z.string().default(''),
  /** The request type the customer chose or the bot recognised (catalog id); empty = New LOA by default. */
  requestTypeId: z.string().default(''),
  intake: IntakeDetailsSchema.default({ representativeName: '', businessName: '', businessIdentifier: '' }),
  updatedAt: z.string(),
});
export type ChatSessionState = z.infer<typeof ChatSessionStateSchema>;

export const EvidenceRequestSchema = z.object({
  evidenceRequestId: z.string().min(1),
  caseRunId: z.string().min(1),
  submissionVersion: z.number().int().positive(),
  sessionId: z.string(),
  processCode: z.string(),
  originatingCheckType: z.string(),
  originatingReasonCode: z.string(),
  evidenceChannel: z.string(),
  requestedItems: z.array(z.string()),
  customerMessage: z.string(),
  status: z.enum(EvidenceRequestStatuses),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: z.string().datetime(),
  dueAt: z.string().datetime(),
  receivedAt: z.string().datetime().optional(),
  resolvedAt: z.string().datetime().optional(),
});
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

export const EvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  evidenceRequestId: z.string().min(1),
  caseRunId: z.string().min(1),
  submissionVersion: z.number().int().positive(),
  evidenceType: z.string(),
  evidenceSource: z.enum(['CHAT_TEXT', 'FILE_UPLOAD']),
  fileName: z.string(),
  mimeType: z.string(),
  storageUrl: z.string(),
  evidenceText: z.string(),
  structuredData: z.record(z.string(), z.unknown()),
  validationStatus: z.enum(['RECEIVED', 'ACCEPTED', 'INSUFFICIENT', 'CONTRADICTORY', 'REJECTED', 'SUPERSEDED']),
  confidence: z.number().min(0).max(1),
  providedAt: z.string().datetime(),
  superseded: z.boolean(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const EvidenceResolutionSchema = z.object({
  resolutionStatus: z.enum(['RESOLVED', 'PARTIAL', 'INSUFFICIENT', 'CONTRADICTORY']),
  supportedFacts: z.array(z.string()),
  remainingGaps: z.array(z.string()),
  reasonCodes: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  recommendedNextAction: z.string(),
  // Hardening (security review SEC-04): "RESOLVED means every requested evidence element is explicitly supported" (source rule 9), so a
  // RESOLVED verdict that cites no supported fact is malformed output, not an acceptance.
}).refine((value) => value.resolutionStatus !== 'RESOLVED' || value.supportedFacts.some((fact) => fact.trim().length > 0), { message: 'RESOLVED requires at least one supported fact', path: ['supportedFacts'] });
export type EvidenceResolution = z.infer<typeof EvidenceResolutionSchema>;

/**
 * The evidence-resolution model output exactly as the source parser schema defines it (snake_case, with the `resolved` flag).
 * Rules 13/14 of the source prompt: resolved is true only when resolution_status is RESOLVED.
 * A JSON-Schema object echoed back by a model (type/properties keys) fails this parse and is a system error, not customer evidence.
 */
export const EvidenceResolutionWireSchema = z.object({
  resolution_status: z.enum(['RESOLVED', 'PARTIAL', 'INSUFFICIENT', 'CONTRADICTORY']),
  resolved: z.boolean(),
  supported_facts: z.array(z.string()),
  remaining_gaps: z.array(z.string()),
  reason_codes: z.array(z.string()),
  recommended_next_action: z.string(),
  confidence: z.number().min(0).max(1),
}).strict().refine((value) => value.resolved === (value.resolution_status === 'RESOLVED'), { message: 'resolved must be true only when resolution_status is RESOLVED' })
  .refine((value) => value.resolution_status !== 'RESOLVED' || value.supported_facts.some((fact) => fact.trim().length > 0), { message: 'RESOLVED requires at least one supported fact' })
  .transform((value): EvidenceResolution => ({ resolutionStatus: value.resolution_status, supportedFacts: value.supported_facts, remainingGaps: value.remaining_gaps, reasonCodes: value.reason_codes, confidence: value.confidence, recommendedNextAction: value.recommended_next_action }));

/** Source "Structured Output Parser" of Workflow 03 (snake_case). Optional arrays default to empty as in the source Normalise node. */
export const ProvisionalWireSchema = z.object({
  case_run_id: z.string(),
  tools_called: z.array(z.string()),
  provisional_outcome: z.string(),
  evidence_summary: z.array(z.string()).default([]),
  missing_information: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
  human_review_required: z.boolean(),
  next_action: z.string(),
  decision_rationale: z.string(),
  confidence: z.number().default(0),
});

export const HumanReviewSchema = z.object({
  reviewId: z.string().min(1),
  caseRunId: z.string().min(1),
  reviewQueue: z.string(),
  agentRecommendation: z.string(),
  reviewerName: z.string(),
  reviewerDecision: z.string(),
  reviewerComments: z.string(),
  overrideReason: z.string(),
  reviewStatus: z.string(),
  requestedAt: z.string(),
  completedAt: z.string(),
});
export type HumanReview = z.infer<typeof HumanReviewSchema>;

export interface CommunicationTemplate {
  templateId: string;
  outcome: string;
  audience: string;
  subjectTemplate: string;
  bodyTemplate: string;
  approvalRequired: boolean;
}

export interface Communication {
  communicationId: string;
  caseRunId: string;
  audience: string;
  templateId: string;
  subject: string;
  body: string;
  status: 'DRAFT';
  approvalRequired: boolean;
  /** Source (Workflow 90/91) records sent=false on the in-flight object; nothing is ever sent by this platform. */
  sent: false;
  createdAt: string;
}

export interface RuntimeCase {
  caseRunId: string;
  caseId: string;
  submissionVersion: number;
  country: string;
  requestType: string;
  businessName: string;
  businessIdentifier: string;
  customerId: string;
  representativeName: string;
  status: string;
  currentStage: string;
  finalOutcome: string;
  targetQueue: string;
  humanReviewRequired: boolean;
  createdAt: string;
  updatedAt: string;
  primaryReasonCode: string;
}

export interface AuditEvent {
  eventId: string;
  caseRunId: string;
  submissionVersion: number;
  timestamp: string;
  actor: string;
  eventType: string;
  stage: string;
  previousState: string;
  newState: string;
  ruleId: string;
  reasonCode: string;
  evidenceReference: string;
  details: Record<string, unknown>;
}

export const EvaluationInputSchema = z.object({ sessionId: z.string().max(200).default('') });
export const ReviewCompletionInputSchema = z.object({ reviewerName: z.string().min(1).max(200), reviewerDecision: z.enum(['APPROVE', 'NEED_MORE_INFORMATION', 'REJECT']), reviewerComments: z.string().min(1).max(10_000), overrideReason: z.string().max(10_000).default('') });
export const ReopenInputSchema = z.object({ reviewerName: z.string().min(1).max(200), comments: z.string().min(1).max(10_000) });

export function splitSemi(value: string | undefined): string[] {
  return (value ?? '').split(';').map((item) => item.trim()).filter(Boolean);
}

export function parseFindings(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { rawValue: value };
  } catch {
    return { parseError: true, rawValue: value };
  }
}

export function toBoolean(value: string | boolean | undefined): boolean {
  return value === true || String(value ?? '').trim().toLowerCase() === 'true' || String(value ?? '').trim().toUpperCase() === 'YES';
}

export function normalizeOutcome(value: string): GovernedOutcome {
  const normalized = value.trim().toUpperCase().replaceAll(' ', '_');
  return (governedOutcomes as readonly string[]).includes(normalized) ? normalized as GovernedOutcome : 'MANUAL_REVIEW';
}

export * from './loa.js';
export * from './loa-personas.js';
export * from './catalog.js';
