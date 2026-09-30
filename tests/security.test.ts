/**
 * Regression tests for the independent security review (docs/security-review.md). Each block names the finding it pins.
 */
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { ClaudeAgentRuntime, scrubbedEnvironment } from '@sbo/agent-runtime';
import { EvidenceResolutionSchema, EvidenceResolutionWireSchema } from '@sbo/domain';
import { InMemoryRepository } from '@sbo/persistence';
import { completeHumanReview, createResubmission, evaluateCase, handleChatMessage, resolveEvidence, resolveEvidenceAndContinue, submitTextEvidence } from '@sbo/workflows';
import { contradictory, insufficient, makePdf, newStore, resolved, ScriptedRuntime } from '@sbo/testkit';
import { buildApp, redactSecrets, type ApiConfig } from '../apps/api/src/app.js';
import { declaredPageCount, extractPdfText } from '../apps/api/src/pdf.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); vi.restoreAllMocks(); });
const authorityText = 'The signed authority letter grants account management, service ordering, plan changes and contract approval.';

async function start(options: { store?: InMemoryRepository; runtime?: ScriptedRuntime; config?: Partial<ApiConfig> } = {}) {
  const uploadDirectory = mkdtempSync(join(tmpdir(), 'sbo-sec-'));
  const store = options.store ?? newStore();
  const app = await buildApp({ repository: store, agentRuntime: options.runtime ?? new ScriptedRuntime(), config: { appBaseUrl: 'http://localhost:5173', sessionSecret: 'a-test-secret-that-is-at-least-32-chars-long', uploadDirectory, rateLimit: { global: 10_000, strict: 10_000 }, ...options.config } });
  apps.push(app);
  const session = await app.inject({ method: 'GET', url: '/api/session' });
  const cookies = Object.fromEntries(session.cookies.map((entry) => [entry.name, entry.value]));
  const { csrfToken } = session.json() as { csrfToken: string };
  const cookie = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
  const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: payload as never, headers: { cookie, 'x-csrf-token': csrfToken, ...headers } });
  const upload = (url: string, file: Buffer, fields: Record<string, string> = {}) => {
    const boundary = '----sec-boundary';
    const parts: Buffer[] = Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence_file"; filename="e.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`));
    return app.inject({ method: 'POST', url, payload: Buffer.concat(parts), headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  };
  return { app, store, uploadDirectory, post, upload, cookie, csrfToken, cookies };
}

describe('SEC-01 PDF parsing is bounded', () => {
  it('extracts a normal text PDF in a worker', async () => {
    expect(await extractPdfText(makePdf('Signed authority letter for Liam Chen to manage the account.'))).toEqual({ text: 'Signed authority letter for Liam Chen to manage the account.' });
  });
  it('refuses a page bomb from its declared page count without parsing it', async () => {
    const bomb = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count 20000 /Kids [] >>\nendobj\n', 'latin1');
    expect(declaredPageCount(bomb)).toBe(20000);
    const started = Date.now();
    expect(await extractPdfText(bomb)).toMatchObject({ text: '', error: 'PDF_TOO_COMPLEX' });
    expect(Date.now() - started).toBeLessThan(500);
  });
  it('refuses a real multi-page document above the page limit', async () => {
    const document = await PDFDocument.create();
    for (let page = 0; page < 60; page += 1) document.addPage();
    expect(await extractPdfText(await document.save())).toMatchObject({ text: '', error: 'PDF_TOO_COMPLEX' });
  });
  it('enforces a hard timeout and reports it as an extraction error, not an exception', async () => {
    expect(await extractPdfText(makePdf('Signed authority letter for Liam Chen to manage the account.'), { timeoutMs: 1 })).toMatchObject({ text: '', error: 'PDF_TOO_COMPLEX', detail: 'timeout' });
  });
  it('reports junk as unreadable and caps output length', async () => {
    expect(await extractPdfText(Buffer.from('%PDF-1.4 this is not a pdf at all'))).toMatchObject({ text: '', error: 'PDF_UNREADABLE' });
    const long = await extractPdfText(makePdf('Signed authority letter for Liam Chen to manage the account.'), { maxChars: 10 });
    expect(long.text).toBe('Signed aut');
  });
  it('does not block the event loop while a PDF is parsed', async () => {
    let ticks = 0;
    const interval = setInterval(() => { ticks += 1; }, 5);
    await Promise.all(Array.from({ length: 5 }, () => extractPdfText(makePdf('Signed authority letter for Liam Chen to manage the account.'))));
    clearInterval(interval);
    expect(ticks).toBeGreaterThan(2);
  });
  it('the upload API answers PDF_TOO_COMPLEX (400) and stores nothing', async () => {
    const ctx = await start();
    const requestId = (await ctx.post('/api/cases/AUTH-003/evaluate', {})).json().evidenceRequest.evidenceRequestId as string;
    const bomb = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count 99999 /Kids [] >>\nendobj\n%%EOF', 'latin1');
    const response = await ctx.upload(`/api/evidence/${requestId}/upload`, bomb);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('PDF_TOO_COMPLEX');
    expect(readdirSync(ctx.uploadDirectory)).toEqual([]);
    expect(await ctx.store.getEvidence(requestId)).toEqual([]);
  });
});

describe('SEC-02 a reviewed or superseded case cannot be silently re-evaluated', () => {
  it('refuses re-evaluation after a human review is completed and leaves the reviewed decision intact', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    const review = (await evaluateCase(store, runtime, 'AUTH-004', 's')).review!;
    await completeHumanReview(store, review.reviewId, { reviewerName: 'Riley', reviewerDecision: 'APPROVE', reviewerComments: 'Verified active.', overrideReason: 'Register was stale.' });
    await expect(evaluateCase(store, runtime, 'AUTH-004', 'other-session')).rejects.toThrow('CASE_LOCKED');
    expect(await store.getDecision('AUTH-004')).toMatchObject({ outcome: 'APPROVE' });
    expect(await store.getRuntimeCase('AUTH-004')).toMatchObject({ status: 'READY_TO_PROCEED' });
    expect(await store.getReviews('AUTH-004')).toHaveLength(1);
  });
  it('tells the chat user, and allows the rerun after an operator resets runtime state', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    const review = (await evaluateCase(store, runtime, 'AUTH-005', 's')).review!;
    await completeHumanReview(store, review.reviewId, { reviewerName: 'R', reviewerDecision: 'REJECT', reviewerComments: 'c' });
    const deps = { repository: store, agentRuntime: runtime, appBaseUrl: 'http://localhost:5173' };
    const reply = await handleChatMessage(deps, { sessionId: 'x', message: 'Evaluate AUTH-005' });
    expect(reply.messages[0]).toContain('has already been reviewed or resubmitted');
    expect(reply.messages.join(' ')).not.toContain('APPROVE');
    await store.resetRuntime();
    expect((await evaluateCase(store, runtime, 'AUTH-005', 's')).decision.outcome).toBe('MANUAL_REVIEW');
  });
  it('locks a superseded original but not its revised version', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    await evaluateCase(store, runtime, 'AUTH-008-V1', 's');
    await createResubmission(store, { originalCaseRunId: 'AUTH-008-V1', revisedCaseRunId: 'AUTH-008-V2', resubmissionComments: 'c' }, runtime);
    await expect(evaluateCase(store, runtime, 'AUTH-008-V1', 's')).rejects.toThrow('CASE_LOCKED');
    expect((await evaluateCase(store, runtime, 'AUTH-008-V2', 's')).decision.outcome).toBe('APPROVE');
  });
  it('the API answers 409 CASE_LOCKED when a resubmission targets a revised case that was already reviewed', async () => {
    const ctx = await start();
    await ctx.post('/api/cases/AUTH-008-V1/evaluate', {});
    await ctx.store.persistReview({ reviewId: 'REV-AUTH-008-V2-1', caseRunId: 'AUTH-008-V2', reviewQueue: 'X', agentRecommendation: 'MANUAL_REVIEW', reviewerName: 'R', reviewerDecision: 'APPROVE', reviewerComments: 'c', overrideReason: '', reviewStatus: 'COMPLETED', requestedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    const response = await ctx.post('/api/resubmissions', { originalCaseRunId: 'AUTH-008-V1', revisedCaseRunId: 'AUTH-008-V2', resubmissionComments: 'c' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'CASE_LOCKED' });
    expect((await ctx.store.getRuntimeCase('AUTH-008-V1'))?.status).not.toBe('SUPERSEDED_BY_RESUBMISSION');
  });
});

describe('SEC-03 evidence resolution and resubmission are atomic under concurrency', () => {
  async function openInsufficient() {
    const store = newStore();
    const runtime = new ScriptedRuntime([insufficient, insufficient, insufficient]);
    const initial = await evaluateCase(store, runtime, 'AUTH-003', 's');
    const id = initial.evidenceRequest!.evidenceRequestId;
    await submitTextEvidence(store, id, { text: 'A partial clarification of the authority.' });
    return { store, runtime, id };
  }
  it('three parallel resolves make exactly one model call and spend exactly one attempt', async () => {
    const { store, runtime, id } = await openInsufficient();
    const results = await Promise.allSettled([1, 2, 3].map(() => resolveEvidence(store, runtime, id, 'AUTH-003', 1)));
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    for (const failure of results.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')) expect(String(failure.reason)).toMatch(/NO_NEW_EVIDENCE_RECEIVED|NOT_READY/);
    expect(runtime.resolutionRequests).toHaveLength(1);
    expect(await store.getEvidenceRequest(id)).toMatchObject({ status: 'INSUFFICIENT', attemptCount: 1 });
  });
  it('two parallel accepted resolves resume the assessment once', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([resolved, resolved]);
    const initial = await evaluateCase(store, runtime, 'AUTH-003', 's');
    const id = initial.evidenceRequest!.evidenceRequestId;
    await submitTextEvidence(store, id, { text: authorityText });
    const results = await Promise.allSettled([resolveEvidenceAndContinue(store, runtime, id, 'AUTH-003', 1, 's'), resolveEvidenceAndContinue(store, runtime, id, 'AUTH-003', 1, 's')]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect((await store.getAudit('AUTH-003')).filter((event) => event.eventType === 'ASSESSMENT_RESUMED')).toHaveLength(1);
    expect(runtime.resolutionRequests).toHaveLength(1);
  });
  it('two parallel resubmissions of one original: one wins, one is refused', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime();
    await evaluateCase(store, runtime, 'AUTH-008-V1', 's');
    const input = { originalCaseRunId: 'AUTH-008-V1', revisedCaseRunId: 'AUTH-008-V2', resubmissionComments: 'c' };
    const results = await Promise.allSettled([createResubmission(store, input, runtime), createResubmission(store, input, runtime)]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(String((results.find((entry) => entry.status === 'rejected') as PromiseRejectedResult).reason)).toContain('RESUBMISSION_ALREADY_CREATED');
    expect((await store.getAudit('AUTH-008-V1')).filter((event) => event.eventType === 'CASE_RESUBMITTED')).toHaveLength(1);
  });
  it('a failed resolution leaves no partial writes (model error inside the step)', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([new Error('EVIDENCE_RESOLUTION_OUTPUT_INVALID: boom')]);
    const initial = await evaluateCase(store, runtime, 'AUTH-003', 's');
    await submitTextEvidence(store, initial.evidenceRequest!.evidenceRequestId, { text: authorityText });
    const before = await store.getRuntimeResults('AUTH-003', 1);
    await expect(resolveEvidence(store, runtime, initial.evidenceRequest!.evidenceRequestId, 'AUTH-003', 1)).rejects.toThrow();
    expect(await store.getRuntimeResults('AUTH-003', 1)).toEqual(before);
  });
  it('an escalation never resets an already COMPLETED evidence review to PENDING (SEC-11)', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([contradictory, contradictory]);
    const first = await evaluateCase(store, runtime, 'AUTH-003', 's');
    await submitTextEvidence(store, first.evidenceRequest!.evidenceRequestId, { text: 'The representative left the company.' });
    const escalated = await resolveEvidenceAndContinue(store, runtime, first.evidenceRequest!.evidenceRequestId, 'AUTH-003', 1);
    expect(escalated.review?.reviewId).toBe('REV-AUTH-003-EVIDENCE-1');
    await completeHumanReview(store, 'REV-AUTH-003-EVIDENCE-1', { reviewerName: 'Riley', reviewerDecision: 'NEED_MORE_INFORMATION', reviewerComments: 'Please clarify.' });
    // a later evidence request on the same case run reaches the same escalation ID
    await store.persistEvidenceRequest({ ...first.evidenceRequest!, evidenceRequestId: 'EVID-AUTH-003-V1-2', status: 'OPEN', attemptCount: 0 });
    await submitTextEvidence(store, 'EVID-AUTH-003-V1-2', { text: 'Second contradictory statement.' });
    const again = await resolveEvidenceAndContinue(store, runtime, 'EVID-AUTH-003-V1-2', 'AUTH-003', 1);
    expect(again.review?.reviewId).toBe('REV-AUTH-003-EVIDENCE-1-2');
    expect((await store.getReview('REV-AUTH-003-EVIDENCE-1'))?.reviewStatus).toBe('COMPLETED');
  });
});

describe('SEC-04 a RESOLVED verdict must cite supported facts', () => {
  const base = { resolution_status: 'RESOLVED', resolved: true, supported_facts: [], remaining_gaps: [], reason_codes: [], recommended_next_action: 'go', confidence: 0.9 };
  it('rejects RESOLVED with no facts (wire and domain schemas)', () => {
    expect(EvidenceResolutionWireSchema.safeParse(base).success).toBe(false);
    expect(EvidenceResolutionWireSchema.safeParse({ ...base, supported_facts: ['   '] }).success).toBe(false);
    expect(EvidenceResolutionWireSchema.safeParse({ ...base, supported_facts: ['Letter grants authority'] }).success).toBe(true);
    expect(EvidenceResolutionSchema.safeParse({ resolutionStatus: 'RESOLVED', supportedFacts: [], remainingGaps: [], reasonCodes: [], confidence: 1, recommendedNextAction: '' }).success).toBe(false);
    expect(EvidenceResolutionSchema.safeParse({ resolutionStatus: 'INSUFFICIENT', supportedFacts: [], remainingGaps: ['x'], reasonCodes: [], confidence: 0.2, recommendedNextAction: '' }).success).toBe(true);
  });
  it('a fact-less RESOLVED verdict consumes no attempt and changes nothing', async () => {
    const store = newStore();
    const runtime = new ScriptedRuntime([{ ...resolved, supportedFacts: [] }]);
    const initial = await evaluateCase(store, runtime, 'AUTH-003', 's');
    await submitTextEvidence(store, initial.evidenceRequest!.evidenceRequestId, { text: authorityText });
    await expect(resolveEvidence(store, runtime, initial.evidenceRequest!.evidenceRequestId, 'AUTH-003', 1)).rejects.toThrow('EVIDENCE_RESOLUTION_OUTPUT_INVALID');
    expect(await store.getEvidenceRequest(initial.evidenceRequest!.evidenceRequestId)).toMatchObject({ status: 'RECEIVED', attemptCount: 0 });
    expect((await store.getRuntimeResults('AUTH-003', 1)).find((row) => row.checkType === 'AUTHORITY_VALIDATION')?.ruleIds).toEqual(['AUTH-004']);
  });
});

describe('SEC-05 errors never leak internals', () => {
  it('a model / SDK failure is a bare code — no paths, keys or schema text — and is logged redacted', async () => {
    const runtime = new ScriptedRuntime([new Error('EVIDENCE_RESOLUTION_OUTPUT_INVALID: spawn C:\\Users\\svc\\node_modules\\@anthropic-ai\\cli.js ENOENT key=sk-ant-api03-SECRETSECRET')]);
    const ctx = await start({ runtime });
    const requestId = (await ctx.post('/api/cases/AUTH-003/evaluate', {})).json().evidenceRequest.evidenceRequestId as string;
    await ctx.post(`/api/evidence/${requestId}/text`, { text: authorityText });
    const response = await ctx.post(`/api/evidence/${requestId}/resolve`, { caseRunId: 'AUTH-003', submissionVersion: 1 });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'EVIDENCE_RESOLUTION_OUTPUT_INVALID' });
    expect(response.body).not.toMatch(/sk-ant|node_modules|C:\\|ENOENT/);
  });
  it('only user-supplied identifiers may appear as detail', async () => {
    const ctx = await start();
    expect((await ctx.post('/api/reviews/REV-NOPE/complete', { reviewerName: 'R', reviewerDecision: 'APPROVE', reviewerComments: 'c' })).json()).toEqual({ error: 'REVIEW_NOT_FOUND' });
  });
  it('redactSecrets removes key material and connection strings', () => {
    const text = redactSecrets('failed key sk-ant-api03-ABC_def-123 at postgres://sbo:hunter2@db:5432/sbo with apiKey=abcd1234 and password: "swordfish"');
    expect(text).not.toMatch(/ABC_def|hunter2|abcd1234|swordfish/);
    expect(text).toContain('sk-ant-[redacted]');
  });
});

describe('SEC-08 CSRF is bound to the server session, and Origin is enforced', () => {
  it('rejects an attacker-chosen cookie/header pair with no server session', async () => {
    const ctx = await start();
    expect((await ctx.app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Evaluate AUTH-001' }, headers: { cookie: 'sbo_csrf=attacker', 'x-csrf-token': 'attacker' } })).statusCode).toBe(403);
  });
  it('rejects a valid token that belongs to a different session', async () => {
    const one = await start();
    const two = await start();
    const response = await one.app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Evaluate AUTH-001' }, headers: { cookie: one.cookie, 'x-csrf-token': two.csrfToken } });
    expect(response.statusCode).toBe(403);
    const crossCookie = await one.app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Evaluate AUTH-001' }, headers: { cookie: `sbo_session=${one.cookies.sbo_session}; sbo_csrf=${two.csrfToken}`, 'x-csrf-token': two.csrfToken } });
    expect(crossCookie.statusCode).toBe(403);
  });
  it('rejects a foreign Origin and accepts the configured one', async () => {
    const ctx = await start();
    expect((await ctx.post('/api/chat', { message: 'Evaluate AUTH-001' }, { origin: 'https://evil.example' })).json()).toEqual({ error: 'ORIGIN_NOT_ALLOWED' });
    expect((await ctx.post('/api/chat', { message: 'Evaluate AUTH-001' }, { origin: 'http://localhost:5173' })).statusCode).toBe(200);
  });
  it('the token is stable per session (derived, not random per call)', async () => {
    const ctx = await start();
    const again = await ctx.app.inject({ method: 'GET', url: '/api/session', headers: { cookie: ctx.cookie } });
    expect(again.json().csrfToken).toBe(ctx.csrfToken);
  });
});

describe('SEC-09 proxy trust is explicit', () => {
  const hit = (ctx: Awaited<ReturnType<typeof start>>, ip: string) => ctx.app.inject({ method: 'POST', url: '/api/cases/AUTH-001/evaluate', payload: {}, headers: { cookie: ctx.cookie, 'x-csrf-token': ctx.csrfToken, 'x-forwarded-for': ip } });
  it('ignores X-Forwarded-For by default (spoofing cannot dodge the limiter)', async () => {
    const ctx = await start({ config: { rateLimit: { global: 10_000, strict: 3 } } });
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) statuses.push((await hit(ctx, `10.0.0.${index}`)).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
  });
  it('honours it only from a configured trusted proxy, and a client-supplied prefix cannot spoof the key', async () => {
    const ctx = await start({ config: { trustProxy: ['127.0.0.1'], rateLimit: { global: 10_000, strict: 2 } } });
    // the proxy (127.0.0.1) appends the real client address as the LAST entry; the attacker controls only what precedes it
    const first = [await hit(ctx, '1.1.1.1, 10.0.0.1'), await hit(ctx, '2.2.2.2, 10.0.0.1'), await hit(ctx, '3.3.3.3, 10.0.0.1')].map((response) => response.statusCode);
    expect(first).toEqual([200, 200, 429]);
    expect((await hit(ctx, '1.1.1.1, 10.0.0.2')).statusCode).toBe(200);
  });
  it('parses the TRUST_PROXY environment value as a list', async () => {
    const { loadEnv } = await import('../apps/api/src/env.js');
    const base = { DATABASE_URL: 'postgres://x', APP_BASE_URL: 'http://localhost:5173', SESSION_SECRET: 'x'.repeat(40), UPLOAD_DIR: './u', AGENT_RUNTIME: 'deterministic' };
    expect(loadEnv(base).TRUST_PROXY).toEqual([]);
    expect(loadEnv({ ...base, TRUST_PROXY: ' 10.0.0.0/8 , 127.0.0.1 ' }).TRUST_PROXY).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });
});

describe('SEC-10 uploads leave no orphaned files', () => {
  it('removes the stored file when the database step refuses a racing upload', async () => {
    const ctx = await start();
    const requestId = (await ctx.post('/api/cases/AUTH-003/evaluate', {})).json().evidenceRequest.evidenceRequestId as string;
    const original = ctx.store.getEvidenceRequest.bind(ctx.store);
    let calls = 0;
    vi.spyOn(ctx.store, 'getEvidenceRequest').mockImplementation(async (id: string) => {
      calls += 1;
      const request = await original(id);
      return calls >= 3 && request ? { ...request, status: 'RECEIVED' as const } : request; // the third read (inside submitUploadedEvidence) sees a concurrent upload
    });
    const response = await ctx.upload(`/api/evidence/${requestId}/upload`, makePdf(authorityText));
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('EVIDENCE_REQUEST_NOT_OPEN');
    expect(readdirSync(ctx.uploadDirectory)).toEqual([]);
  });
  it('rejects a closed request before reading the file body', async () => {
    const ctx = await start();
    const requestId = (await ctx.post('/api/cases/AUTH-003/evaluate', {})).json().evidenceRequest.evidenceRequestId as string;
    await ctx.post(`/api/evidence/${requestId}/cancel`, {});
    const response = await ctx.upload(`/api/evidence/${requestId}/upload`, makePdf(authorityText));
    expect(response.json().error).toBe('EVIDENCE_REQUEST_NOT_OPEN');
    expect(existsSync(ctx.uploadDirectory) && readdirSync(ctx.uploadDirectory)).toEqual([]);
  });
});

describe('SEC-12 the agent subprocess does not inherit application secrets', () => {
  it('scrubbedEnvironment drops DATABASE_URL, SESSION_SECRET and the API key', () => {
    const env = scrubbedEnvironment({ DATABASE_URL: 'postgres://u:p@h/db', SESSION_SECRET: 's'.repeat(40), ANTHROPIC_API_KEY: 'k', PATH: '/bin', HOME: '/home/x' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/x' });
  });
  it('the SDK call receives the key explicitly and never the database URL or cookie secret', async () => {
    process.env.DATABASE_URL = 'postgres://leak:leak@db/x'; process.env.SESSION_SECRET = 'leak'.repeat(10);
    const calls: Array<{ options: { env: Record<string, string> } }> = [];
    const sdk = { tool: () => ({}), createSdkMcpServer: () => ({}), query: (params: { options: { env: Record<string, string> } }) => { calls.push(params); return (async function* () { yield { type: 'result', result: 'not json' }; })(); } };
    try {
      await new ClaudeAgentRuntime({ model: 'm', apiKey: 'explicit-key', loadSdk: async () => sdk as never }).resolveEvidence({ caseRunId: 'A', requestId: 'E', evidenceRequest: {}, caseContext: {}, evidenceRecords: [] }).catch(() => undefined);
    } finally { delete process.env.DATABASE_URL; delete process.env.SESSION_SECRET; }
    expect(calls[0]!.options.env.ANTHROPIC_API_KEY).toBe('explicit-key');
    expect(calls[0]!.options.env.DATABASE_URL).toBeUndefined();
    expect(calls[0]!.options.env.SESSION_SECRET).toBeUndefined();
  });
});
