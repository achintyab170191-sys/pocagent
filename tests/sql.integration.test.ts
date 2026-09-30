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
import { completeHumanReview, evaluateCase, handleChatEvidenceUpload, handleChatMessage, listReviewDashboard, openIntakeCase, reopenCase, resolveEvidence, submitDocumentEvidence } from '@sbo/workflows';
import { finalizeDecision } from '@sbo/governance';
import { caseWithDocuments, persona, personaAttachments, ScriptedRuntime } from '@sbo/testkit';

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

describe('PostgresRepository — the To-Be process on real SQL', () => {
  const deps = () => ({ repository, agentRuntime: new ScriptedRuntime(), appBaseUrl: 'x' });
  const intro = (slug: string, sessionId = 's') => handleChatMessage(deps(), { sessionId, message: `My name is ${persona(slug).representativeName} and I represent ${persona(slug).businessName}` });
  const attach = (slug: string, types?: string[], sessionId = 's') => handleChatEvidenceUpload(deps(), { sessionId, files: personaAttachments(slug, types) });

  it('Fatima approves: five unique rows, decision, DRAFT communication, runtime case and audit persisted', async () => {
    const opened = await intro('fatima-al-noor');
    const result = await attach('fatima-al-noor');
    expect(result.outcome).toMatchObject({ governedOutcome: 'APPROVE', primaryReasonCode: 'ALL_CHECKS_PASSED' });
    const rows = await sql<{ check_type: string }[]>`SELECT check_type FROM runtime_utility_results WHERE case_run_id = ${opened.caseRunId} ORDER BY sequence`;
    expect(rows.map((row) => row.check_type)).toEqual(['TRADE_LICENSE_CHECK', 'IDENTITY_VALIDATION', 'POA_MOA_CHECK', 'BAD_DEBT_CHECK', 'AVCV_VERIFICATION']);
    expect(await repository.getDecision(opened.caseRunId)).toMatchObject({ decisionId: `DEC-${opened.caseRunId}-1`, outcome: 'APPROVE' });
    expect((await repository.getCommunications(opened.caseRunId))[0]).toMatchObject({ communicationId: `COMM-${opened.caseRunId}-V1-INITIAL`, templateId: 'COMM-APPROVE', status: 'DRAFT', sent: false });
    expect((await repository.getRuntimeCase(opened.caseRunId))?.status).toBe('READY_TO_PROCEED');
    expect((await repository.getAudit(opened.caseRunId)).filter((event) => event.eventType === 'UTILITY_CHECK_COMPLETED')).toHaveLength(5);
    expect((await repository.getEvidence(opened.evidenceRequest!.evidenceRequestId)).map((row) => row.validationStatus)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
  });

  it('re-evaluating resets and rewrites without duplicating rows, decisions or communications', async () => {
    const caseRunId = (await repository.listCases())[0]!.caseRunId;
    await evaluateCase(repository, new ScriptedRuntime(), caseRunId, 's');
    expect(await count(`runtime_utility_results WHERE case_run_id = '${caseRunId}'`)).toBe(5);
    expect(await count(`communications WHERE case_run_id = '${caseRunId}'`)).toBe(1);
    expect(await count(`decisions WHERE case_run_id = '${caseRunId}'`)).toBe(1);
  });

  it('Omar: the POA request persists, the accepted document replaces only the originating check, and the case is approved', async () => {
    await repository.resetRuntime();
    const opened = await intro('omar-gulf-horizon');
    const asked = await attach('omar-gulf-horizon', ['EMIRATES_ID', 'TRADE_LICENSE', 'ESTABLISHMENT_CARD']);
    expect(asked.outcome).toMatchObject({ governedOutcome: 'NEED_MORE_INFORMATION', primaryReasonCode: 'POA_MOA_MISSING' });
    const poaRequest = asked.evidenceRequest!.evidenceRequestId;
    expect(await repository.getEvidenceRequest(poaRequest)).toMatchObject({ originatingCheckType: 'POA_MOA_CHECK', status: 'OPEN' });
    const resumed = await attach('omar-gulf-horizon', ['POA_MOA']);
    expect(resumed.outcome).toMatchObject({ governedOutcome: 'APPROVE', toolsCalled: ['POA/MOA Check', 'Bad Debt Check', 'AVCV Verification'] });
    expect(await repository.getEvidenceRequest(poaRequest)).toMatchObject({ status: 'ACCEPTED', attemptCount: 1 });
    expect(await count(`runtime_utility_results WHERE case_run_id = '${opened.caseRunId}'`)).toBe(5);
    const poa = await sql<{ payload: { status: string } }[]>`SELECT payload FROM runtime_utility_results WHERE case_run_id = ${opened.caseRunId} AND check_type = 'POA_MOA_CHECK'`;
    expect(poa).toHaveLength(1);
    expect(poa[0]!.payload.status).toBe('PASS');
  });

  it('a rejected case waits on the dashboard; the human review completes exactly once (row lock + status guard)', async () => {
    await repository.resetRuntime();
    const opened = await intro('sara-desert-bloom');
    await attach('sara-desert-bloom');
    const [row] = await listReviewDashboard(repository);
    expect(row).toMatchObject({ caseRunId: opened.caseRunId, reviewStatus: 'PENDING_REJECTION_CONFIRMATION', primaryReasonCode: 'TRADE_LICENSE_EXPIRED' });
    const input = { reviewerName: 'Riley', reviewerDecision: 'REJECT' as const, reviewerComments: 'Confirmed.' };
    const results = await Promise.allSettled([completeHumanReview(repository, row!.reviewId, input), completeHumanReview(repository, row!.reviewId, { ...input, reviewerName: 'Second' })]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(await count(`audit_events WHERE case_run_id = '${opened.caseRunId}' AND payload->>'eventType' = 'HUMAN_REVIEW_COMPLETED'`)).toBe(1);
    expect(await count(`audit_events WHERE case_run_id = '${opened.caseRunId}' AND payload->>'eventType' = 'RCA_REQUESTED'`)).toBe(1);
    expect((await repository.getReview(row!.reviewId))?.reviewStatus).toBe('COMPLETED');
    await expect(evaluateCase(repository, new ScriptedRuntime(), opened.caseRunId, 's')).rejects.toThrow('CASE_LOCKED');
  });

  it('parallel evidence resolutions on one request are serialised under a row lock: one attempt is spent', async () => {
    await repository.resetRuntime();
    const opened = await intro('fatima-al-noor');
    const id = opened.evidenceRequest!.evidenceRequestId;
    await submitDocumentEvidence(repository, id, { fileName: 'a.pdf', mimeType: 'application/pdf', storageUrl: 'x', extractedText: personaAttachments('fatima-al-noor', ['EMIRATES_ID'])[0]!.extractedText });
    const results = await Promise.allSettled([resolveEvidence(repository, id, opened.caseRunId, 1), resolveEvidence(repository, id, opened.caseRunId, 1)]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(await repository.getEvidenceRequest(id)).toMatchObject({ status: 'INSUFFICIENT', attemptCount: 1 });
  });

  it('reopen works on real SQL: a new version, the old one closed, its review closed, and the customer\'s chat session repointed', async () => {
    await repository.resetRuntime();
    const opened = await intro('sara-desert-bloom', 'sess-sql');
    await attach('sara-desert-bloom', undefined, 'sess-sql');
    const reopened = await reopenCase(repository, { caseRunId: opened.caseRunId, reviewerName: 'Riley', comments: 'Send the renewed licence.' });
    expect(reopened.reopened).toMatchObject({ caseRunId: `${opened.caseRunId}-V2`, submissionVersion: 2 });
    expect(await repository.getRuntimeCase(opened.caseRunId)).toMatchObject({ status: 'REOPENED_AS_NEW_VERSION' });
    expect((await repository.getReviews(opened.caseRunId))[0]).toMatchObject({ reviewStatus: 'CLOSED_REOPENED', reviewerDecision: 'REOPEN' });
    expect(await repository.getSession('sess-sql')).toMatchObject({ step: 'AWAITING_EVIDENCE', caseRunId: `${opened.caseRunId}-V2`, evidenceRequestId: reopened.request.evidenceRequestId });
    const again = await attach('sara-desert-bloom', undefined, 'sess-sql');
    expect(again.caseRunId).toBe(`${opened.caseRunId}-V2`);
    expect(await repository.getRuntimeResults(`${opened.caseRunId}-V2`, 2)).toHaveLength(1);
    expect(await repository.getRuntimeResults(opened.caseRunId, 1)).toHaveLength(1);
    await expect(reopenCase(repository, { caseRunId: opened.caseRunId, reviewerName: 'R', comments: 'again' })).rejects.toThrow('REOPEN_NOT_ALLOWED');
  });

  it('decision, communication, runtime case and audit are atomic: a failure rolls all of them back', async () => {
    await repository.resetRuntime();
    const { caseRunId } = await caseWithDocuments('fatima-al-noor', undefined, repository);
    await evaluateCase(repository, new ScriptedRuntime(), caseRunId, 's');
    await sql`DELETE FROM decisions`; await sql`DELETE FROM communications`; await sql`DELETE FROM audit_events WHERE payload->>'eventType' IN ('DECISION_GENERATED', 'COMMUNICATION_DRAFTED', 'CASE_STATE_CHANGED')`;
    // Spy on the prototype so the transaction-scoped repository instances created inside finalizeDecision also fail.
    const spy = vi.spyOn(PostgresRepository.prototype, 'appendAudit').mockRejectedValue(new Error('audit unavailable'));
    try {
      await expect(finalizeDecision(repository, caseRunId, 1, 'RUNTIME')).rejects.toThrow('audit unavailable');
    } finally { spy.mockRestore(); }
    for (const table of ['decisions', 'communications']) expect(await count(table), table).toBe(0);
  });

  it('nested transactions join the outer one: an inner failure undoes the outer writes', async () => {
    await expect(repository.transaction(async (outer) => {
      await outer.persistEvidenceRequest({ evidenceRequestId: 'EVID-X', caseRunId: 'AUTH-101', submissionVersion: 1, sessionId: '', processCode: 'P-1.1', originatingCheckType: 'DOCUMENT_INTAKE', originatingReasonCode: 'X', evidenceChannel: 'FILE_UPLOAD', requestedItems: [], customerMessage: '', status: 'OPEN', attemptCount: 0, maxAttempts: 3, createdAt: new Date().toISOString(), dueAt: new Date().toISOString() });
      await outer.transaction(async () => { throw new Error('inner failure'); });
    })).rejects.toThrow('inner failure');
    expect(await repository.getEvidenceRequest('EVID-X')).toBeUndefined();
  });

  it('intake cases: sequential ids, a company that is not on record is only a new lead, and reset restarts the sequence', async () => {
    await repository.resetRuntime();
    const known = await openIntakeCase(repository, { representativeName: 'Fatima Al Mansoori', businessName: 'Al Noor Trading LLC', businessIdentifier: '' });
    expect(known).toMatchObject({ kind: 'KNOWN_BUSINESS', caseRecord: { caseRunId: 'AUTH-101', businessName: 'Al Noor Trading LLC' } });
    const lead = await openIntakeCase(repository, { representativeName: 'Zed Nobody', businessName: 'Acme Imaginary Holdings Ltd', businessIdentifier: '' });
    expect(lead).toMatchObject({ kind: 'NEW_LEAD', caseRecord: { caseRunId: 'AUTH-102', requestType: 'NEW_LEAD' } });
    expect(await repository.getDecision(lead.caseRecord.caseRunId)).toBeUndefined();
    expect(await repository.getRuntimeResults(lead.caseRecord.caseRunId, 1)).toEqual([]);
    await repository.resetRuntime();
    expect((await openIntakeCase(repository, { representativeName: 'Fatima Al Mansoori', businessName: 'Al Noor Trading LLC', businessIdentifier: '' })).caseRecord.caseRunId).toBe('AUTH-101');
    await repository.resetRuntime();
  });

  it('resetRuntime clears runtime state and leaves the archived n8n fixtures and migrations intact', async () => {
    await intro('fatima-al-noor');
    await attach('fatima-al-noor');
    expect(await count('runtime_utility_results')).toBeGreaterThan(0);
    await repository.resetRuntime();
    for (const table of runtimeTables) expect(await count(table), table).toBe(0);
    expect(await count('intake_cases')).toBe(0);
    expect(await count('source.dt_decision_rules')).toBe(csvRows('dt_decision_rules'));
    expect(await count('schema_migrations')).toBe(4);
    await repository.resetRuntime();
  });
});