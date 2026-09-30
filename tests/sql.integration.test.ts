/**
 * Runs the real SQL layer (migrations, constraints, importers, PostgresRepository, transactions) against an embedded PostgreSQL
 * (PGlite) exposed over the wire protocol, so the same `postgres` driver code path as production is exercised without Docker.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresRepository, historicalRuntimeTables, importHistoricalRuntime, loadSourceData, loadSourceDataFromDb, migrate, parseCsvMatrix, seedStaticFixtures, staticFixtureTables } from '@sbo/persistence';
import { openIntakeCase, completeHumanReview, createResubmission, evaluateCase, resolveEvidence, resolveEvidenceAndContinue, submitTextEvidence } from '@sbo/workflows';
import { finalizeDecision } from '@sbo/governance';
import { resolved, ScriptedRuntime } from '@sbo/testkit';

let db: PGlite; let server: PGLiteSocketServer; let sql: Sql; let repository: PostgresRepository;
const port = 54000 + Math.floor(Math.random() * 900);
const BOM_PATTERN = new RegExp(`^${String.fromCharCode(0xfeff)}`);
const csvRows = (table: string): number => parseCsvMatrix(readFileSync(`${table}.csv`, 'utf8').replace(BOM_PATTERN, '')).slice(1).filter((row) => row.some((value) => value !== '')).length;

beforeAll(async () => {
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  sql = postgres(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1, onnotice: () => undefined });
  await migrate(sql);
  await seedStaticFixtures(sql, process.cwd());
  repository = new PostgresRepository(sql, await loadSourceDataFromDb(sql));
}, 120_000);
afterAll(async () => { await sql?.end(); await server?.stop(); await db?.close(); });

const count = async (table: string): Promise<number> => (await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n as number;
const runtimeTables = ['runtime_utility_results', 'runtime_cases', 'decisions', 'evidence_requests', 'case_evidence', 'human_reviews', 'communications', 'audit_events', 'chat_sessions'];

describe('migrations', () => {
  it('are recorded once and re-running is a no-op', async () => {
    expect((await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`).map((row) => row.name)).toEqual(['0001_runtime.sql', '0002_chat_sessions.sql', '0003_constraints.sql', '0004_intake_cases.sql']);
    expect(await migrate(sql)).toEqual([]);
  });
});

describe('importers: static fixtures vs runtime history', () => {
  it('seeds every static fixture with exact source column names and row counts', async () => {
    for (const table of staticFixtureTables) expect(await count(`source."${table}"`), table).toBe(csvRows(table));
    const columns = (await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'source' AND table_name = 'dt_synthetic_cases' ORDER BY ordinal_position`).map((row) => row.column_name);
    expect(columns).toEqual(['_row_number', 'Case_Run_ID', 'Case_ID', 'Submission_Version', 'Country', 'Request_Type', 'Channel', 'Business_Name_Submitted', 'Business_Identifier_Submitted', 'Customer_ID', 'Representative_Name', 'Representative_Role', 'Requested_Authority', 'Customer_Request_Narrative', 'Documents_Submitted', 'Submitted_At', 'Processing_Priority', 'Synthetic_Only']);
  });

  it('the typed domain adapter over the seeded DB equals the adapter over the CSV files', async () => {
    const fromFiles = loadSourceData(process.cwd());
    const fromDb = await loadSourceDataFromDb(sql);
    expect(fromDb.cases).toEqual(fromFiles.cases);
    expect(fromDb.rules).toEqual(fromFiles.rules);
    expect(fromDb.mockResults).toEqual(fromFiles.mockResults);
    expect(fromDb.templates).toEqual(fromFiles.templates);
  });

  it('the seed leaves the runtime baseline empty (stale execution history is never seeded)', async () => {
    for (const table of runtimeTables) expect(await count(table), table).toBe(0);
    const history = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'history'`;
    expect(history).toEqual([]);
  });

  it('historical runtime exports import only into the separate history schema', async () => {
    await importHistoricalRuntime(sql, process.cwd());
    for (const table of historicalRuntimeTables) expect(await count(`history."${table}"`), table).toBe(csvRows(table));
    for (const table of runtimeTables) expect(await count(table), table).toBe(0);
    expect((await sql.unsafe(`SELECT "case_Run_ID" FROM history.dt_cases_runtime LIMIT 1`)).length).toBe(1); // source casing preserved
  });

  it('re-seeding is idempotent', async () => {
    await seedStaticFixtures(sql, process.cwd());
    expect(await count('source.dt_decision_rules')).toBe(csvRows('dt_decision_rules'));
  });
});

describe('database constraints on runtime results', () => {
  const insert = (over: Record<string, unknown> = {}) => {
    const row = { case_run_id: 'T-1', submission_version: 1, check_type: 'DOCUMENT_EXTRACTION', sequence: 1, superseded: false, payload: { caseRunId: 'T-1', submissionVersion: 1, checkType: 'DOCUMENT_EXTRACTION' }, ...over };
    return sql`INSERT INTO runtime_utility_results (case_run_id, submission_version, check_type, sequence, superseded, payload) VALUES (${row.case_run_id as string}, ${row.submission_version as number}, ${row.check_type as string}, ${row.sequence as number}, ${row.superseded as boolean}, ${sql.json(row.payload as never)})`;
  };
  const failsWith = async (promise: PromiseLike<unknown>, code: string) => { await expect(Promise.resolve(promise)).rejects.toMatchObject({ code }); };

  it('two active rows for the same case + version + check_type are impossible (unique violation)', async () => {
    await insert();
    await failsWith(insert(), '23505');
    await insert({ check_type: 'BUSINESS_VALIDATION', payload: { caseRunId: 'T-1', submissionVersion: 1, checkType: 'BUSINESS_VALIDATION' } }); // a different check is fine
    await insert({ submission_version: 2, payload: { caseRunId: 'T-1', submissionVersion: 2, checkType: 'DOCUMENT_EXTRACTION' } }); // a different version is fine
    await insert({ superseded: true }); // superseded history rows may repeat
    expect(await count(`runtime_utility_results WHERE case_run_id = 'T-1'`)).toBe(4);
  });

  it('rejects malformed keys: lower-case or blank check_type, version < 1, payload that disagrees with the key', async () => {
    await failsWith(insert({ case_run_id: 'T-2', check_type: 'document_extraction', payload: { caseRunId: 'T-2', submissionVersion: 1, checkType: 'document_extraction' } }), '23514');
    await failsWith(insert({ case_run_id: 'T-2', check_type: ' ', payload: { caseRunId: 'T-2', submissionVersion: 1, checkType: ' ' } }), '23514');
    await failsWith(insert({ case_run_id: 'T-2', submission_version: 0, payload: { caseRunId: 'T-2', submissionVersion: 0, checkType: 'DOCUMENT_EXTRACTION' } }), '23514');
    await failsWith(insert({ case_run_id: 'T-2', payload: { caseRunId: 'T-2', submissionVersion: 1, checkType: 'BUSINESS_VALIDATION' } }), '23514');
    await failsWith(insert({ case_run_id: 'T-2', payload: { caseRunId: 'OTHER', submissionVersion: 1, checkType: 'DOCUMENT_EXTRACTION' } }), '23514');
  });

  it('cleanup', async () => { await sql`DELETE FROM runtime_utility_results`; expect(await count('runtime_utility_results')).toBe(0); });
});

describe('PostgresRepository — full workflows on real SQL', () => {
  it('AUTH-001 approves: seven unique rows, decision, DRAFT communication, runtime case and audit persisted', async () => {
    const result = await evaluateCase(repository, new ScriptedRuntime(), 'AUTH-001', 's');
    expect(result.decision).toMatchObject({ outcome: 'APPROVE', primaryReasonCode: 'ALL_CHECKS_PASSED' });
    const rows = await sql<{ check_type: string }[]>`SELECT check_type FROM runtime_utility_results WHERE case_run_id = 'AUTH-001' ORDER BY sequence`;
    expect(rows.map((row) => row.check_type)).toEqual(['DOCUMENT_EXTRACTION', 'BUSINESS_VALIDATION', 'IDENTITY_VALIDATION', 'AUTHORITY_VALIDATION', 'SYSTEM_DATA_CHECK', 'FINANCIAL_CHECK', 'FINAL_VERIFICATION']);
    expect(await repository.getDecision('AUTH-001')).toMatchObject({ decisionId: 'DEC-AUTH-001-1', outcome: 'APPROVE' });
    expect((await repository.getCommunications('AUTH-001'))[0]).toMatchObject({ communicationId: 'COMM-AUTH-001-V1-INITIAL', status: 'DRAFT', sent: false });
    expect((await repository.getRuntimeCase('AUTH-001'))?.status).toBe('READY_TO_PROCEED');
    expect((await repository.getAudit('AUTH-001')).filter((event) => event.eventType === 'UTILITY_CHECK_COMPLETED')).toHaveLength(7);
  });

  it('re-evaluating resets and rewrites without duplicating rows or communications', async () => {
    await evaluateCase(repository, new ScriptedRuntime(), 'AUTH-001', 's');
    expect(await count(`runtime_utility_results WHERE case_run_id = 'AUTH-001'`)).toBe(7);
    expect(await count(`communications WHERE case_run_id = 'AUTH-001'`)).toBe(1);
    expect(await count(`decisions WHERE case_run_id = 'AUTH-001'`)).toBe(1);
  });

  it('AUTH-003 evidence loop persists request, evidence and the replaced originating check', async () => {
    const runtime = new ScriptedRuntime([resolved]);
    const initial = await evaluateCase(repository, runtime, 'AUTH-003', 's');
    const id = initial.evidenceRequest!.evidenceRequestId;
    await submitTextEvidence(repository, id, { text: 'The signed authority letter grants account management, service ordering and approvals.' });
    const outcome = await resolveEvidenceAndContinue(repository, runtime, id, 'AUTH-003', 1, 's');
    expect(outcome.route).toBe('RESUMED');
    expect(await repository.getEvidenceRequest(id)).toMatchObject({ status: 'ACCEPTED', attemptCount: 1 });
    const authority = await sql<{ payload: { status: string; ruleIds: string[] } }[]>`SELECT payload FROM runtime_utility_results WHERE case_run_id = 'AUTH-003' AND check_type = 'AUTHORITY_VALIDATION'`;
    expect(authority).toHaveLength(1);
    expect(authority[0]!.payload).toMatchObject({ status: 'PASS', ruleIds: ['EVID-001'] });
    expect((await repository.getEvidence(id))[0]?.validationStatus).toBe('ACCEPTED');
  });

  it('a human review completes exactly once (row lock + status guard)', async () => {
    const review = (await evaluateCase(repository, new ScriptedRuntime(), 'AUTH-005', 's')).review!;
    const input = { reviewerName: 'Riley', reviewerDecision: 'NEED_MORE_INFORMATION' as const, reviewerComments: 'Please reconcile the CRM names.' };
    const results = await Promise.allSettled([completeHumanReview(repository, review.reviewId, input), completeHumanReview(repository, review.reviewId, { ...input, reviewerName: 'Second' })]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(await count(`audit_events WHERE case_run_id = 'AUTH-005' AND payload->>'eventType' = 'HUMAN_REVIEW_COMPLETED'`)).toBe(1);
    expect((await repository.getReview(review.reviewId))?.reviewStatus).toBe('COMPLETED');
  });

  it('parallel evidence resolutions on one request are serialised under a row lock: one model call, one attempt', async () => {
    await repository.resetRuntime();
    const runtime = new ScriptedRuntime([{ ...resolved, resolutionStatus: 'INSUFFICIENT', supportedFacts: [], remainingGaps: ['gap'], confidence: 0.3 }, { ...resolved, resolutionStatus: 'INSUFFICIENT', supportedFacts: [], remainingGaps: ['gap'], confidence: 0.3 }]);
    const initial = await evaluateCase(repository, runtime, 'AUTH-003', 's');
    const id = initial.evidenceRequest!.evidenceRequestId;
    await submitTextEvidence(repository, id, { text: 'A partial clarification of the authority.' });
    const results = await Promise.allSettled([resolveEvidence(repository, runtime, id, 'AUTH-003', 1), resolveEvidence(repository, runtime, id, 'AUTH-003', 1)]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(runtime.resolutionRequests).toHaveLength(1);
    expect(await repository.getEvidenceRequest(id)).toMatchObject({ status: 'INSUFFICIENT', attemptCount: 1 });
  });

  it('versioned resubmission works on real SQL: V1 needs information, V2 is approved, V1 is superseded', async () => {
    await repository.resetRuntime();
    const runtime = new ScriptedRuntime();
    expect((await evaluateCase(repository, runtime, 'AUTH-008-V1', 's')).decision.outcome).toBe('NEED_MORE_INFORMATION');
    const revised = await createResubmission(repository, { originalCaseRunId: 'AUTH-008-V1', revisedCaseRunId: 'AUTH-008-V2', resubmissionComments: 'Updated authority letter.' }, runtime);
    expect(revised.decision).toMatchObject({ outcome: 'APPROVE', caseRunId: 'AUTH-008-V2', submissionVersion: 2 });
    expect(await repository.getRuntimeCase('AUTH-008-V1')).toMatchObject({ status: 'SUPERSEDED_BY_RESUBMISSION' });
    expect((await repository.getAudit('AUTH-008-V1')).map((event) => event.eventType)).toContain('CASE_RESUBMITTED');
    await repository.resetRuntime();
  });

  it('a reviewed case cannot be re-evaluated against real SQL either (CASE_LOCKED)', async () => {
    await repository.resetRuntime();
    const review = (await evaluateCase(repository, new ScriptedRuntime(), 'AUTH-004', 's')).review!;
    await completeHumanReview(repository, review.reviewId, { reviewerName: 'Riley', reviewerDecision: 'APPROVE', reviewerComments: 'ok', overrideReason: 'stale register' });
    await expect(evaluateCase(repository, new ScriptedRuntime(), 'AUTH-004', 's')).rejects.toThrow('CASE_LOCKED');
    expect((await repository.getDecision('AUTH-004'))?.outcome).toBe('APPROVE');
    await repository.resetRuntime();
  });

  it('decision, communication, runtime case and audit are atomic: a failure rolls all of them back', async () => {
    await repository.resetRuntime();
    // Spy on the prototype so the transaction-scoped repository instances created inside finalizeDecision also fail.
    const spy = vi.spyOn(PostgresRepository.prototype, 'appendAudit').mockRejectedValue(new Error('audit unavailable'));
    try {
      await expect(finalizeDecision(repository, 'AUTH-001', 1, 'MOCK')).rejects.toThrow('audit unavailable');
    } finally { spy.mockRestore(); }
    for (const table of ['decisions', 'communications', 'runtime_cases', 'audit_events']) expect(await count(table), table).toBe(0);
  });

  it('nested transactions join the outer one: an inner failure undoes the outer writes', async () => {
    await expect(repository.transaction(async (outer) => {
      await outer.persistEvidenceRequest({ evidenceRequestId: 'EVID-X', caseRunId: 'AUTH-001', submissionVersion: 1, sessionId: '', processCode: 'P-1.1', originatingCheckType: 'AUTHORITY_VALIDATION', originatingReasonCode: 'X', evidenceChannel: 'CHAT_TEXT', requestedItems: [], customerMessage: '', status: 'OPEN', attemptCount: 0, maxAttempts: 3, createdAt: new Date().toISOString(), dueAt: new Date().toISOString() });
      await outer.transaction(async () => { throw new Error('inner failure'); });
    })).rejects.toThrow('inner failure');
    expect(await repository.getEvidenceRequest('EVID-X')).toBeUndefined();
  });

  it('intake cases: sequential ids, scenario-backed evaluation on SQL, and reset restarts the sequence', async () => {
    const opened = await openIntakeCase(repository, { representativeName: 'Liam Chen', businessName: 'Bluegum Vector Demo Pty Ltd', businessIdentifier: '' });
    expect(opened.caseRecord.caseRunId).toMatch(/^AUTH-1\d\d$/);
    expect(opened.scenario?.caseRunId).toBe('AUTH-003');
    const again = await openIntakeCase(repository, { representativeName: 'Zed Nobody', businessName: 'Acme Imaginary Holdings Ltd', businessIdentifier: '' });
    expect(Number(again.caseRecord.caseRunId.slice(5))).toBe(Number(opened.caseRecord.caseRunId.slice(5)) + 1);
    expect(again.kind).toBe('NEW_LEAD');
    expect(await repository.getDecision(again.caseRecord.caseRunId)).toBeUndefined();
    await repository.resetRuntime();
    expect((await openIntakeCase(repository, { representativeName: 'Liam Chen', businessName: 'Bluegum Vector Demo Pty Ltd', businessIdentifier: '' })).caseRecord.caseRunId).toBe('AUTH-101');
    await repository.resetRuntime();
  });
  it('resetRuntime clears runtime state and leaves source fixtures, rules and migrations intact', async () => {
    await evaluateCase(repository, new ScriptedRuntime(), 'AUTH-001', 's');
    expect(await count('runtime_utility_results')).toBeGreaterThan(0);
    await repository.resetRuntime();
    for (const table of runtimeTables) expect(await count(table), table).toBe(0);
    expect(await count('source.dt_decision_rules')).toBe(csvRows('dt_decision_rules'));
    expect(await count('source.dt_mock_utility_results')).toBe(csvRows('dt_mock_utility_results'));
    expect(await count('schema_migrations')).toBe(4);
    // and the same case can be evaluated again from the clean baseline
    expect((await evaluateCase(repository, new ScriptedRuntime(), 'AUTH-001', 's')).decision.outcome).toBe('APPROVE');
  });
});
