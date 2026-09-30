import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import {
  type AuditEvent,
  type CaseRecord,
  type ChatSessionState,
  type Communication,
  type CommunicationTemplate,
  type Decision,
  type DecisionRule,
  type Evidence,
  type EvidenceRequest,
  type HumanReview,
  type RuntimeCase,
  type UtilityResult,
  parseFindings,
  splitSemi,
  toBoolean,
} from '@sbo/domain';

type CsvRecord = Record<string, string>;

export interface SourceData {
  cases: Map<string, CaseRecord>;
  rules: DecisionRule[];
  mockResults: Map<string, UtilityResultFixture>;
  templates: Map<string, CommunicationTemplate>;
  rawTables: Map<string, CsvRecord[]>;
}

export type UtilityResultFixture = Omit<UtilityResult, 'resultId' | 'submissionVersion' | 'isTerminal' | 'terminalOutcome' | 'prototypeData' | 'superseded' | 'createdAt'>;

export interface Repository {
  transaction<T>(operation: (repository: Repository) => Promise<T>): Promise<T>;
  getCase(caseRunId: string): Promise<CaseRecord | undefined>;
  listCases(): Promise<CaseRecord[]>;
  getRules(): Promise<DecisionRule[]>;
  getMockResult(caseRunId: string, checkType: string): Promise<UtilityResultFixture | undefined>;
  getMockResults(caseRunId: string): Promise<UtilityResultFixture[]>;
  getTemplate(templateId: string): Promise<CommunicationTemplate | undefined>;
  getRuntimeResults(caseRunId: string, submissionVersion: number): Promise<UtilityResult[]>;
  /** Idempotent write keyed exactly by case_run_id + submission_version + check_type. */
  upsertUtilityResult(result: UtilityResult): Promise<void>;
  /** SBO.02 "Reset Runtime Utility Results": deletes only the exact case_run_id + submission_version rows. */
  deleteRuntimeResults(caseRunId: string, submissionVersion: number): Promise<void>;
  getSession(sessionId: string): Promise<ChatSessionState | undefined>;
  saveSession(session: ChatSessionState): Promise<void>;
  getDecision(caseRunId: string): Promise<Decision | undefined>;
  persistDecision(decision: Decision): Promise<void>;
  getRuntimeCase(caseRunId: string): Promise<RuntimeCase | undefined>;
  persistRuntimeCase(runtimeCase: RuntimeCase): Promise<void>;
  getEvidenceRequest(evidenceRequestId: string): Promise<EvidenceRequest | undefined>;
  getEvidenceRequests(caseRunId: string): Promise<EvidenceRequest[]>;
  persistEvidenceRequest(request: EvidenceRequest): Promise<void>;
  getEvidence(evidenceRequestId: string): Promise<Evidence[]>;
  persistEvidence(evidence: Evidence): Promise<void>;
  getReview(reviewId: string): Promise<HumanReview | undefined>;
  getReviews(caseRunId: string): Promise<HumanReview[]>;
  persistReview(review: HumanReview): Promise<void>;
  persistCommunication(communication: Communication): Promise<void>;
  getCommunications(caseRunId: string): Promise<Communication[]>;
  appendAudit(event: AuditEvent): Promise<void>;
  getAudit(caseRunId: string): Promise<AuditEvent[]>;
  resetRuntime(): Promise<void>;
  close(): Promise<void>;
}

/** Leading byte-order mark of a UTF-8 file (built from its char code so no invisible character lives in this source file). */
const BOM_PATTERN = new RegExp(`^${String.fromCharCode(0xfeff)}`);
export type { CsvRecord };
export function parseCsv(input: string): CsvRecord[] {
  const [headers = [], ...values] = parseCsvMatrix(input);
  return values.filter((row) => row.some((value) => value !== '')).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}

/** RFC-4180 style parser: quoted fields, doubled quotes, embedded newlines. Row 0 is the header row (exact source column names/casing). */
export function parseCsvMatrix(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? '';
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += character;
  }
  if (field || row.length > 0) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

function readTable(root: string, file: string): CsvRecord[] {
  return parseCsv(readFileSync(join(root, file), 'utf8').replace(/^\uFEFF/, ''));
}

function isoNow(): string { return new Date().toISOString(); }

/**
 * Static reference fixtures (seed data). Runtime tables and their historical exports are deliberately NOT in this list: the exported
 * runtime rows (dt_utility_results_runtime, dt_cases_runtime, dt_decisions, ...) are stale execution history, never clean seed data.
 */
export const staticFixtureTables = [
  'dt_synthetic_cases', 'dt_mock_utility_results', 'dt_decision_rules', 'dt_communication_templates',
  'dt_business_register', 'dt_crm_accounts', 'dt_financial_records', 'dt_documents_index',
  'dt_country_requirements', 'dt_process_catalog', 'dt_reason_codes',
] as const;

/** Exported runtime state (execution history). Importable for reference/analysis only, into the separate `history` schema. */
export const historicalRuntimeTables = [
  'dt_utility_results_runtime', 'dt_cases_runtime', 'dt_decisions', 'dt_evidence_requests', 'dt_case_evidence', 'dt_human_reviews', 'dt_communications', 'dt_audit_events',
] as const;

export function readCsvTable(root: string, table: string): { headers: string[]; rows: CsvRecord[] } {
  const text = readFileSync(join(root, `${table}.csv`), 'utf8').replace(BOM_PATTERN, '');
  return { headers: parseCsvMatrix(text)[0] ?? [], rows: parseCsv(text) };
}

export function loadSourceData(root = process.cwd()): SourceData {
  return buildSourceData(new Map(staticFixtureTables.map((table) => [table, readTable(root, `${table}.csv`)])));
}

/** Typed domain adapter over raw string rows (exact source column names), whether they came from CSV files or the `source` schema. */
export function buildSourceData(rawTables: Map<string, CsvRecord[]>): SourceData {
  const cases = new Map((rawTables.get('dt_synthetic_cases') ?? []).map((row) => {
    const caseRecord: CaseRecord = {
      caseRunId: row.Case_Run_ID ?? '', caseId: row.Case_ID ?? '', submissionVersion: Number(row.Submission_Version ?? 1), country: (row.Country ?? '').trim(), requestType: (row.Request_Type ?? '').trim(), channel: (row.Channel ?? '').trim(),
      businessName: row.Business_Name_Submitted ?? '', businessIdentifier: row.Business_Identifier_Submitted ?? '', customerId: row.Customer_ID ?? '', representativeName: row.Representative_Name ?? '', representativeRole: row.Representative_Role ?? '', requestedAuthority: row.Requested_Authority ?? '', requestNarrative: row.Customer_Request_Narrative ?? '', documentsSubmitted: row.Documents_Submitted ?? '', submittedAt: row.Submitted_At ?? '', processingPriority: row.Processing_Priority ?? '', syntheticOnly: toBoolean(row.Synthetic_Only),
    };
    return [caseRecord.caseRunId, caseRecord];
  }));
  const rules = (rawTables.get('dt_decision_rules') ?? []).map((row): DecisionRule => ({
    priority: Number(row.Priority ?? 9999), ruleId: row.Rule_ID ?? '', stage: row.Stage ?? '', condition: row.Condition ?? '', requiredEvidence: row.Required_Evidence ?? '', utilityAgent: row.Utility_Agent ?? '', checkResult: row.Check_Result ?? '', finalOutcome: row.Final_Outcome ?? '', reasonCode: row.Reason_Code ?? '', humanReviewRequired: toBoolean(row.Human_Review_Required), nextAction: row.Next_Action ?? '', targetQueue: row.Target_Queue ?? '', communicationTemplateId: row.Communication_Template_ID ?? '', ruleOwner: row.Rule_Owner ?? '', ruleStatus: row.Rule_Status ?? '', notes: row.Notes ?? '',
  }));
  const mockResults = new Map((rawTables.get('dt_mock_utility_results') ?? []).map((row): [string, UtilityResultFixture] => {
    const fixture: UtilityResultFixture = {
      caseRunId: row.Case_Run_ID ?? '', sequence: Number(row.Sequence ?? 0), agentId: row.Agent_ID ?? '', utilityName: row.Utility_Name ?? '', checkType: row.Check_Type ?? '', status: row.Status ?? '', findings: parseFindings(row.Findings_JSON), reasonCodes: splitSemi(row.Reason_Codes), evidenceReferences: splitSemi(row.Evidence_References), confidence: Number(row.Confidence ?? 0), humanReviewRequired: toBoolean(row.Human_Review_Required), recommendedNextStep: row.Recommended_Next_Step ?? '', ruleIds: splitSemi(row.Rule_IDs), ruleStatusUsed: row.Rule_Status_Used ?? '',
    };
    return [`${fixture.caseRunId}|${fixture.checkType}`, fixture];
  }));
  const templates = new Map((rawTables.get('dt_communication_templates') ?? []).map((row): [string, CommunicationTemplate] => [row.Template_ID ?? '', {
    templateId: row.Template_ID ?? '', outcome: row.Outcome ?? '', audience: row.Audience ?? '', subjectTemplate: row.Subject_Template ?? '', bodyTemplate: row.Body_Template ?? '', approvalRequired: toBoolean(row.Approval_Required),
  }]));
  return { cases, rules, mockResults, templates, rawTables };
}

function deepCopy<T>(value: T): T { return structuredClone(value); }

/**
 * Source lookup: dt_mock_utility_results filtered by Case_Run_ID and `Check_Type ILIKE '<CHECK_TYPE>'`.
 * n8n data-table ILIKE is a case-insensitive substring match (evidenced by the historical AUTH-009 run, whose fixture row is
 * DOCUMENT_EXTRACTION_AND_SECURITY yet is returned to Workflow 05). Do not "tighten" this to equality.
 */
export function findMockResult(source: SourceData, caseRunId: string, checkType: string): UtilityResultFixture | undefined {
  const needle = checkType.trim().toUpperCase();
  const match = [...source.mockResults.values()].filter((row) => row.caseRunId === caseRunId && row.checkType.toUpperCase().includes(needle)).sort((left, right) => left.sequence - right.sequence)[0];
  return match ? deepCopy(match) : undefined;
}

export class InMemoryRepository implements Repository {
  private readonly utilityResults = new Map<string, UtilityResult>();
  private readonly decisions = new Map<string, Decision>();
  private readonly runtimeCases = new Map<string, RuntimeCase>();
  private readonly evidenceRequests = new Map<string, EvidenceRequest>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly reviews = new Map<string, HumanReview>();
  private readonly communications = new Map<string, Communication>();
  private readonly audit = new Map<string, AuditEvent>();
  private readonly sessions = new Map<string, ChatSessionState>();
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private lock: Promise<void> = Promise.resolve();
  public constructor(private readonly source: SourceData) {}
  private key(caseRunId: string, submissionVersion: number, checkType: string): string { return `${caseRunId}|${submissionVersion}|${checkType.toUpperCase()}`; }
  /** Serialises top-level transactions (like Postgres row locks) while letting nested calls join the enclosing one. */
  public async transaction<T>(operation: (repository: Repository) => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) return this.runTransaction(operation);
    const previous = this.lock;
    let release: () => void = () => undefined;
    this.lock = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try { return await this.transactionContext.run(true, () => this.runTransaction(operation)); } finally { release(); }
  }
  private async runTransaction<T>(operation: (repository: Repository) => Promise<T>): Promise<T> {
    const snapshot = deepCopy({ utilityResults: this.utilityResults, decisions: this.decisions, runtimeCases: this.runtimeCases, evidenceRequests: this.evidenceRequests, evidence: this.evidence, reviews: this.reviews, communications: this.communications, audit: this.audit, sessions: this.sessions });
    try { return await operation(this); } catch (error) {
      this.sessions.clear(); snapshot.sessions.forEach((value, key) => this.sessions.set(key, value));
      this.utilityResults.clear(); snapshot.utilityResults.forEach((value, key) => this.utilityResults.set(key, value));
      this.decisions.clear(); snapshot.decisions.forEach((value, key) => this.decisions.set(key, value));
      this.runtimeCases.clear(); snapshot.runtimeCases.forEach((value, key) => this.runtimeCases.set(key, value));
      this.evidenceRequests.clear(); snapshot.evidenceRequests.forEach((value, key) => this.evidenceRequests.set(key, value));
      this.evidence.clear(); snapshot.evidence.forEach((value, key) => this.evidence.set(key, value));
      this.reviews.clear(); snapshot.reviews.forEach((value, key) => this.reviews.set(key, value));
      this.communications.clear(); snapshot.communications.forEach((value, key) => this.communications.set(key, value));
      this.audit.clear(); snapshot.audit.forEach((value, key) => this.audit.set(key, value));
      throw error;
    }
  }
  public async getCase(caseRunId: string): Promise<CaseRecord | undefined> { return deepCopy(this.source.cases.get(caseRunId)); }
  public async listCases(): Promise<CaseRecord[]> { return deepCopy([...this.source.cases.values()]); }
  public async getRules(): Promise<DecisionRule[]> { return deepCopy(this.source.rules); }
  public async getMockResult(caseRunId: string, checkType: string): Promise<UtilityResultFixture | undefined> { return findMockResult(this.source, caseRunId, checkType); }
  public async getMockResults(caseRunId: string): Promise<UtilityResultFixture[]> { return deepCopy([...this.source.mockResults.values()].filter((row) => row.caseRunId === caseRunId).sort((left, right) => left.sequence - right.sequence)); }
  public async getTemplate(templateId: string): Promise<CommunicationTemplate | undefined> { return deepCopy(this.source.templates.get(templateId)); }
  public async deleteRuntimeResults(caseRunId: string, submissionVersion: number): Promise<void> { for (const [key, row] of this.utilityResults) if (row.caseRunId === caseRunId && row.submissionVersion === submissionVersion) this.utilityResults.delete(key); }
  public async getSession(sessionId: string): Promise<ChatSessionState | undefined> { return deepCopy(this.sessions.get(sessionId)); }
  public async saveSession(session: ChatSessionState): Promise<void> { this.sessions.set(session.sessionId, deepCopy(session)); }
  public async getRuntimeResults(caseRunId: string, submissionVersion: number): Promise<UtilityResult[]> { return deepCopy([...this.utilityResults.values()].filter((row) => row.caseRunId === caseRunId && row.submissionVersion === submissionVersion && !row.superseded).sort((left, right) => left.sequence - right.sequence)); }
  public async upsertUtilityResult(result: UtilityResult): Promise<void> { this.utilityResults.set(this.key(result.caseRunId, result.submissionVersion, result.checkType), deepCopy({ ...result, checkType: result.checkType.toUpperCase(), superseded: false })); }
  public async getDecision(caseRunId: string): Promise<Decision | undefined> { return deepCopy(this.decisions.get(caseRunId)); }
  public async persistDecision(decision: Decision): Promise<void> { this.decisions.set(decision.caseRunId, deepCopy(decision)); }
  public async getRuntimeCase(caseRunId: string): Promise<RuntimeCase | undefined> { return deepCopy(this.runtimeCases.get(caseRunId)); }
  public async persistRuntimeCase(runtimeCase: RuntimeCase): Promise<void> { this.runtimeCases.set(runtimeCase.caseRunId, deepCopy(runtimeCase)); }
  public async getEvidenceRequest(evidenceRequestId: string): Promise<EvidenceRequest | undefined> { return deepCopy(this.evidenceRequests.get(evidenceRequestId)); }
  public async getEvidenceRequests(caseRunId: string): Promise<EvidenceRequest[]> { return deepCopy([...this.evidenceRequests.values()].filter((row) => row.caseRunId === caseRunId).sort((left, right) => right.createdAt.localeCompare(left.createdAt))); }
  public async persistEvidenceRequest(request: EvidenceRequest): Promise<void> { this.evidenceRequests.set(request.evidenceRequestId, deepCopy(request)); }
  public async getEvidence(evidenceRequestId: string): Promise<Evidence[]> { return deepCopy([...this.evidence.values()].filter((row) => row.evidenceRequestId === evidenceRequestId && !row.superseded).sort((left, right) => left.providedAt.localeCompare(right.providedAt))); }
  public async persistEvidence(evidence: Evidence): Promise<void> { this.evidence.set(evidence.evidenceId, deepCopy(evidence)); }
  public async getReview(reviewId: string): Promise<HumanReview | undefined> { return deepCopy(this.reviews.get(reviewId)); }
  public async getReviews(caseRunId: string): Promise<HumanReview[]> { return deepCopy([...this.reviews.values()].filter((row) => row.caseRunId === caseRunId)); }
  public async persistReview(review: HumanReview): Promise<void> { this.reviews.set(review.reviewId, deepCopy(review)); }
  public async persistCommunication(communication: Communication): Promise<void> { this.communications.set(communication.communicationId, deepCopy(communication)); }
  public async getCommunications(caseRunId: string): Promise<Communication[]> { return deepCopy([...this.communications.values()].filter((row) => row.caseRunId === caseRunId).sort((left, right) => right.createdAt.localeCompare(left.createdAt))); }
  public async appendAudit(event: AuditEvent): Promise<void> { this.audit.set(event.eventId, deepCopy(event)); }
  public async getAudit(caseRunId: string): Promise<AuditEvent[]> { return deepCopy([...this.audit.values()].filter((event) => event.caseRunId === caseRunId).sort((left, right) => left.timestamp.localeCompare(right.timestamp))); }
  public async resetRuntime(): Promise<void> { this.sessions.clear(); this.utilityResults.clear(); this.decisions.clear(); this.runtimeCases.clear(); this.evidenceRequests.clear(); this.evidence.clear(); this.reviews.clear(); this.communications.clear(); this.audit.clear(); }
  public async close(): Promise<void> {}
}

type PayloadRecord = { payload: unknown };

export class PostgresRepository implements Repository {
  public constructor(private readonly sql: Sql, private readonly source: SourceData, private readonly inTransaction = false) {}
  /** Inside a transaction, `lock` takes a row lock (FOR UPDATE) so read-modify-write steps on the same row serialise (security review SEC-03). */
  private async getOne<T>(table: string, keyColumn: string, key: string, lock = false): Promise<T | undefined> {
    const rows = lock && this.inTransaction
      ? await this.sql<PayloadRecord[]>`SELECT payload FROM ${this.sql(table)} WHERE ${this.sql(keyColumn)} = ${key} LIMIT 1 FOR UPDATE`
      : await this.sql<PayloadRecord[]>`SELECT payload FROM ${this.sql(table)} WHERE ${this.sql(keyColumn)} = ${key} LIMIT 1`;
    return rows.length ? rows[0]?.payload as T : undefined;
  }
  public async transaction<T>(operation: (repository: Repository) => Promise<T>): Promise<T> {
    // Nested calls join the enclosing transaction so a whole workflow step commits or rolls back together.
    if (this.inTransaction) return operation(this);
    return this.sql.begin(async (transactionSql) => operation(new PostgresRepository(transactionSql as unknown as Sql, this.source, true))) as Promise<T>;
  }
  public async getCase(caseRunId: string): Promise<CaseRecord | undefined> { return deepCopy(this.source.cases.get(caseRunId)); }
  public async listCases(): Promise<CaseRecord[]> { return deepCopy([...this.source.cases.values()]); }
  public async getRules(): Promise<DecisionRule[]> { return deepCopy(this.source.rules); }
  public async getMockResult(caseRunId: string, checkType: string): Promise<UtilityResultFixture | undefined> { return findMockResult(this.source, caseRunId, checkType); }
  public async getMockResults(caseRunId: string): Promise<UtilityResultFixture[]> { return deepCopy([...this.source.mockResults.values()].filter((row) => row.caseRunId === caseRunId).sort((left, right) => left.sequence - right.sequence)); }
  public async getTemplate(templateId: string): Promise<CommunicationTemplate | undefined> { return deepCopy(this.source.templates.get(templateId)); }
  public async deleteRuntimeResults(caseRunId: string, submissionVersion: number): Promise<void> { await this.sql`DELETE FROM runtime_utility_results WHERE case_run_id = ${caseRunId} AND submission_version = ${submissionVersion}`; }
  public async getSession(sessionId: string): Promise<ChatSessionState | undefined> { return this.getOne<ChatSessionState>('chat_sessions', 'session_id', sessionId); }
  public async saveSession(session: ChatSessionState): Promise<void> { await this.sql`INSERT INTO chat_sessions (session_id, payload) VALUES (${session.sessionId}, ${this.sql.json(session as never)}) ON CONFLICT (session_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`; }
  public async getRuntimeResults(caseRunId: string, submissionVersion: number): Promise<UtilityResult[]> { const rows = await this.sql<PayloadRecord[]>`SELECT payload FROM runtime_utility_results WHERE case_run_id = ${caseRunId} AND submission_version = ${submissionVersion} AND superseded = false ORDER BY sequence`; return rows.map((row) => row.payload as UtilityResult); }
  public async upsertUtilityResult(result: UtilityResult): Promise<void> { await this.sql`INSERT INTO runtime_utility_results (case_run_id, submission_version, check_type, sequence, superseded, payload) VALUES (${result.caseRunId}, ${result.submissionVersion}, ${result.checkType.toUpperCase()}, ${result.sequence}, false, ${this.sql.json(result as never)}) ON CONFLICT (case_run_id, submission_version, check_type) WHERE (superseded = false) DO UPDATE SET sequence = EXCLUDED.sequence, payload = EXCLUDED.payload, updated_at = now()`; }
  public async getDecision(caseRunId: string): Promise<Decision | undefined> { return this.getOne<Decision>('decisions', 'case_run_id', caseRunId, true); }
  public async persistDecision(decision: Decision): Promise<void> { await this.sql`INSERT INTO decisions (case_run_id, payload) VALUES (${decision.caseRunId}, ${this.sql.json(decision as never)}) ON CONFLICT (case_run_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`; }
  public async getRuntimeCase(caseRunId: string): Promise<RuntimeCase | undefined> { return this.getOne<RuntimeCase>('runtime_cases', 'case_run_id', caseRunId, true); }
  public async persistRuntimeCase(runtimeCase: RuntimeCase): Promise<void> { await this.sql`INSERT INTO runtime_cases (case_run_id, payload) VALUES (${runtimeCase.caseRunId}, ${this.sql.json(runtimeCase as never)}) ON CONFLICT (case_run_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`; }
  public async getEvidenceRequest(evidenceRequestId: string): Promise<EvidenceRequest | undefined> { return this.getOne<EvidenceRequest>('evidence_requests', 'evidence_request_id', evidenceRequestId, true); }
  public async getEvidenceRequests(caseRunId: string): Promise<EvidenceRequest[]> { const rows = await this.sql<PayloadRecord[]>`SELECT payload FROM evidence_requests WHERE case_run_id = ${caseRunId} ORDER BY created_at DESC`; return rows.map((row) => row.payload as EvidenceRequest); }
  public async persistEvidenceRequest(request: EvidenceRequest): Promise<void> { await this.sql`INSERT INTO evidence_requests (evidence_request_id, case_run_id, payload) VALUES (${request.evidenceRequestId}, ${request.caseRunId}, ${this.sql.json(request as never)}) ON CONFLICT (evidence_request_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`; }
  public async getEvidence(evidenceRequestId: string): Promise<Evidence[]> { const rows = await this.sql<PayloadRecord[]>`SELECT payload FROM case_evidence WHERE evidence_request_id = ${evidenceRequestId} AND superseded = false ORDER BY provided_at`; return rows.map((row) => row.payload as Evidence); }
  public async persistEvidence(evidence: Evidence): Promise<void> { await this.sql`INSERT INTO case_evidence (evidence_id, evidence_request_id, superseded, payload) VALUES (${evidence.evidenceId}, ${evidence.evidenceRequestId}, ${evidence.superseded}, ${this.sql.json(evidence as never)}) ON CONFLICT (evidence_id) DO UPDATE SET payload = EXCLUDED.payload, superseded = EXCLUDED.superseded`; }
  public async getReview(reviewId: string): Promise<HumanReview | undefined> {
    // Inside a transaction the row is locked so concurrent reviewer submissions serialise (duplicate-completion guard).
    if (!this.inTransaction) return this.getOne<HumanReview>('human_reviews', 'review_id', reviewId);
    const rows = await this.sql<PayloadRecord[]>`SELECT payload FROM human_reviews WHERE review_id = ${reviewId} FOR UPDATE`;
    return rows.length ? rows[0]?.payload as HumanReview : undefined;
  }
  public async getReviews(caseRunId: string): Promise<HumanReview[]> { const rows = await this.sql<PayloadRecord[]>`SELECT payload FROM human_reviews WHERE case_run_id = ${caseRunId}`; return rows.map((row) => row.payload as HumanReview); }
  public async persistReview(review: HumanReview): Promise<void> { await this.sql`INSERT INTO human_reviews (review_id, case_run_id, payload) VALUES (${review.reviewId}, ${review.caseRunId}, ${this.sql.json(review as never)}) ON CONFLICT (review_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`; }
  public async persistCommunication(communication: Communication): Promise<void> { await this.sql`INSERT INTO communications (communication_id, case_run_id, payload) VALUES (${communication.communicationId}, ${communication.caseRunId}, ${this.sql.json(communication as never)}) ON CONFLICT (communication_id) DO UPDATE SET payload = EXCLUDED.payload`; }
  public async getCommunications(caseRunId: string): Promise<Communication[]> { const rows = await this.sql<PayloadRecord[]>`SELECT payload FROM communications WHERE case_run_id = ${caseRunId} ORDER BY created_at DESC`; return rows.map((row) => row.payload as Communication); }
  public async appendAudit(event: AuditEvent): Promise<void> { await this.sql`INSERT INTO audit_events (event_id, case_run_id, payload) VALUES (${event.eventId}, ${event.caseRunId}, ${this.sql.json(event as never)})`; }
  public async getAudit(caseRunId: string): Promise<AuditEvent[]> { const rows = await this.sql<PayloadRecord[]>`SELECT payload FROM audit_events WHERE case_run_id = ${caseRunId} ORDER BY created_at`; return rows.map((row) => row.payload as AuditEvent); }
  public async resetRuntime(): Promise<void> { await this.sql`TRUNCATE chat_sessions, runtime_utility_results, runtime_cases, decisions, evidence_requests, case_evidence, human_reviews, communications, audit_events`; }
  public async close(): Promise<void> { await this.sql.end(); }
}

export function createPostgresRepository(databaseUrl: string, source: SourceData, options: { max?: number } = {}): PostgresRepository { return new PostgresRepository(postgres(databaseUrl, { max: options.max ?? 10, onnotice: () => undefined }), source); }
export function createSqlClient(databaseUrl: string, options: { max?: number } = {}): Sql { return postgres(databaseUrl, { max: options.max ?? 2, onnotice: () => undefined }); }
export * from './importer.js';
export function runtimeResultId(caseRunId: string, submissionVersion: number, checkType: string): string { return `RUN-${caseRunId}-V${submissionVersion}-${checkType}`; }
export function now(): string { return isoNow(); }

let lastMillis = 0;
/**
 * Strictly increasing millisecond clock for ID construction. The source builds IDs from Date.now() (e.g. EVIDENCE-{case}-{ms},
 * EVT-...-{ms}); two writes in one millisecond would collide and silently overwrite each other, so IDs keep the source format
 * but never repeat within a process.
 */
export function uniqueMillis(): number {
  const current = Date.now();
  lastMillis = current > lastMillis ? current : lastMillis + 1;
  return lastMillis;
}
