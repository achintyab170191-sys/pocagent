import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { InMemoryRepository } from '@sbo/persistence';
import { buildApp } from '../apps/api/src/app.js';
import { loadEnv } from '../apps/api/src/env.js';
import { submitDocumentEvidence } from '@sbo/workflows';
import { newStore, persona, personaAttachments, ScriptedRuntime } from '@sbo/testkit';

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });
const intro = (slug: string): string => `My name is ${persona(slug).representativeName} and I represent ${persona(slug).businessName}`;

async function start(options: { store?: InMemoryRepository; runtime?: ScriptedRuntime; maxUploadBytes?: number; secureCookies?: boolean } = {}) {
  const uploadDirectory = mkdtempSync(join(tmpdir(), 'sbo-uploads-'));
  const store = options.store ?? newStore();
  const app = await buildApp({ repository: store, agentRuntime: options.runtime ?? new ScriptedRuntime(), config: { appBaseUrl: 'http://localhost:5173', sessionSecret: 'a-test-secret-that-is-at-least-32-chars-long', uploadDirectory, maxUploadBytes: options.maxUploadBytes, secureCookies: options.secureCookies } });
  apps.push(app);
  const session = await app.inject({ method: 'GET', url: '/api/session' });
  const cookies = Object.fromEntries(session.cookies.map((entry) => [entry.name, entry.value]));
  const { csrfToken, sessionId } = session.json() as { csrfToken: string; sessionId: string };
  const cookieHeader = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
  const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: payload as never, headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken, ...headers } });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
  /** POST /api/chat/evidence or /api/evidence/:id/upload with any number of files. */
  const attach = (url: string, files: Array<{ name: string; type: string; content: Buffer }>, fields: Record<string, string> = {}) => {
    const boundary = '----sbo-boundary-1234';
    const parts: Buffer[] = Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    for (const file of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence_file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.content, Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return app.inject({ method: 'POST', url, payload: Buffer.concat(parts), headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  };
  const pdfs = (slug: string, types?: string[]) => personaAttachments(slug, types).map((file) => ({ name: file.fileName, type: 'application/pdf', content: file.bytes }));
  return { app, store, runtime: options.runtime, uploadDirectory, post, get, attach, pdfs, csrfToken, sessionId, cookieHeader, session };
}

describe('session, CSRF and headers', () => {
  it('issues a signed HttpOnly SameSite=Strict session cookie and a readable CSRF cookie', async () => {
    const { session, sessionId } = await start();
    const sessionCookie = session.cookies.find((entry) => entry.name === 'sbo_session')!;
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(sessionCookie.value).not.toContain(sessionId.slice(0, 8) + '=');
    expect(session.cookies.find((entry) => entry.name === 'sbo_csrf')).toMatchObject({ sameSite: 'Strict' });
    expect(session.json()).toMatchObject({ syntheticDataOnly: true });
  });

  it('marks cookies Secure when configured for production', async () => {
    const { session } = await start({ secureCookies: true });
    expect(session.cookies.every((entry) => entry.secure === true)).toBe(true);
  });

  it('rejects state-changing requests without a matching CSRF token', async () => {
    const { app, cookieHeader, csrfToken } = await start();
    const url = '/api/chat';
    const payload = { message: 'hello' };
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, payload, headers: { cookie: cookieHeader } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, payload, headers: { cookie: cookieHeader, 'x-csrf-token': 'forged' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, payload, headers: { 'x-csrf-token': csrfToken } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, payload, headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken } })).statusCode).toBe(200);
  });

  it('sets security headers and answers health without state', async () => {
    const { get } = await start();
    const health = await get('/health');
    expect(health.json()).toEqual({ status: 'ok', syntheticDataOnly: true });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(String(health.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(String(health.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(String(health.headers['content-security-policy'])).not.toContain('unsafe-inline');
  });

  it('rate-limits the public chat endpoint', async () => {
    const { post } = await start();
    const statuses: number[] = [];
    for (let index = 0; index < 25; index += 1) statuses.push((await post('/api/chat', { message: 'hello' })).statusCode);
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(20).every((status) => status === 429)).toBe(true);
  });
});

describe('chat API (customer journey over HTTP)', () => {
  it('a new customer introduces themselves, attaches the documents and gets a curated approval — nothing internal leaks', async () => {
    const ctx = await start();
    const opened = (await ctx.post('/api/chat', { message: intro('fatima-al-noor') })).json();
    expect(opened).toMatchObject({ step: 'AWAITING_EVIDENCE', sessionId: ctx.sessionId, syntheticDataDisclaimer: true });
    expect(opened.caseRunId).toMatch(/^AUTH-1\d\d$/);
    const done = await ctx.attach('/api/chat/evidence', ctx.pdfs('fatima-al-noor'));
    expect(done.statusCode).toBe(200);
    const body = done.json();
    expect(body).toMatchObject({ step: 'DONE', outcome: { governedOutcome: 'APPROVE', primaryReasonCode: 'ALL_CHECKS_PASSED' } });
    expect(body.messages.join('\n')).toContain('Eligible to proceed');
    expect(done.body).not.toMatch(/systemMessage|internalSummary|findings|rule_ids|CTRL-|TL-DEMO|784-1985|PD-DEMO|apiKey|ANTHROPIC|SBO\.02 Agentic/i);
    expect((await ctx.store.getDecision(opened.caseRunId))?.outcome).toBe('APPROVE');
  });

  it('keeps one server-issued conversation session across requests (the client cannot choose the session id)', async () => {
    const { post } = await start();
    const first = (await post('/api/chat', { message: intro('fatima-al-noor') })).json();
    const second = (await post('/api/chat', { message: 'some words' })).json();
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.step).toBe('AWAITING_EVIDENCE');
    const spoofed = await post('/api/chat', { message: 'cancel', sessionId: 'someone-elses-session' });
    expect(spoofed.json().sessionId).toBe(first.sessionId);
    expect((await post('/api/chat', '{"message": ', { 'content-type': 'application/json' })).statusCode).toBe(400);
  });

  it('a company that is not on record becomes a new lead over HTTP', async () => {
    const { post } = await start();
    const body = (await post('/api/chat', { message: 'My name is Zed Nobody and I represent Acme Imaginary Holdings Ltd' })).json();
    expect(body.step).toBe('DONE');
    expect(body.messages[0]).toContain('new lead case');
    expect(body.outcome).toBeUndefined();
  });

  it('GET /api/chat/state returns what the conversation is waiting for (and null otherwise)', async () => {
    const { post, get } = await start();
    expect((await get('/api/chat/state')).json().state).toBeNull();
    await post('/api/chat', { message: intro('omar-gulf-horizon') });
    const state = (await get('/api/chat/state')).json().state;
    expect(state).toMatchObject({ step: 'AWAITING_EVIDENCE', evidenceRequest: { requestedItems: expect.arrayContaining(['Trade License of the business']) } });
  });

  it('a POA is requested in the same conversation and the assessment resumes after it is attached', async () => {
    const ctx = await start();
    await ctx.post('/api/chat', { message: intro('omar-gulf-horizon') });
    const asked = (await ctx.attach('/api/chat/evidence', ctx.pdfs('omar-gulf-horizon', ['EMIRATES_ID', 'TRADE_LICENSE', 'ESTABLISHMENT_CARD']))).json();
    expect(asked).toMatchObject({ step: 'AWAITING_EVIDENCE', outcome: { governedOutcome: 'NEED_MORE_INFORMATION', primaryReasonCode: 'POA_MOA_MISSING' } });
    const resumed = (await ctx.attach('/api/chat/evidence', ctx.pdfs('omar-gulf-horizon', ['POA_MOA']))).json();
    expect(resumed).toMatchObject({ step: 'DONE', outcome: { governedOutcome: 'APPROVE', toolsCalled: ['POA/MOA Check', 'Bad Debt Check', 'AVCV Verification'] } });
  });

  it('demo personas are listed with their sample documents and expected outcomes', async () => {
    const { get } = await start();
    const body = (await get('/api/scenarios')).json();
    expect(body.scenarios).toHaveLength(16);
    expect(body.scenarios[0]).toMatchObject({ slug: 'fatima-al-noor', expectedOutcome: 'APPROVE', documents: [{ type: 'EMIRATES_ID', path: '/samples/fatima-al-noor/emirates-id.pdf' }, expect.anything(), expect.anything()] });
  });

  it('a recommended rejection is never shown to the customer: the browser receives PENDING_CONFIRMATION, the dashboard keeps the truth', async () => {
    const ctx = await start();
    await ctx.post('/api/chat', { message: intro('sara-desert-bloom') });
    const body = (await ctx.attach('/api/chat/evidence', ctx.pdfs('sara-desert-bloom'))).json();
    expect(body).toMatchObject({ step: 'DONE', outcome: { governedOutcome: 'PENDING_CONFIRMATION', primaryReasonCode: 'UNDER_REVIEW', provisionalOutcome: 'PENDING_CONFIRMATION', governanceOverride: false } });
    expect(JSON.stringify(body)).not.toMatch(/REJECT|TRADE_LICENSE_EXPIRED|expired/i);
    expect((await ctx.get('/api/reviews')).json().reviews[0]).toMatchObject({ agentRecommendation: 'REJECT', primaryReasonCode: 'TRADE_LICENSE_EXPIRED' });
  });

  it('lists only synthetic cases opened in this runtime', async () => {
    const { post, get } = await start();
    expect((await get('/api/cases')).json().cases).toEqual([]);
    await post('/api/chat', { message: intro('fatima-al-noor') });
    expect((await get('/api/cases')).json().cases).toEqual([{ caseRunId: 'AUTH-101', caseId: 'AUTH-101', submissionVersion: 1, businessName: 'Al Noor Trading LLC' }]);
  });

  it('serves the case status, 404 for an unknown case and 422 for a malformed id', async () => {
    const ctx = await start();
    const opened = (await ctx.post('/api/chat', { message: intro('fatima-al-noor') })).json();
    expect((await ctx.get(`/api/cases/${opened.caseRunId}/status`)).json()).toMatchObject({ currentStatus: 'WAITING_FOR_EVIDENCE', latestEvidenceRequest: { status: 'OPEN' }, syntheticDataDisclaimer: true });
    expect((await ctx.get('/api/cases/AUTH-404/status')).statusCode).toBe(404);
    expect((await ctx.get('/api/cases/nope/status')).statusCode).toBe(422);
  });
});

describe('document upload API', () => {
  it('several files of different formats in one message: PDF, Word and an unreadable one is refused as a whole with nothing stored', async () => {
    const ctx = await start();
    await ctx.post('/api/chat', { message: intro('fatima-al-noor') });
    const [eid, licence] = ctx.pdfs('fatima-al-noor');
    const refused = await ctx.attach('/api/chat/evidence', [eid!, licence!, { name: 'notes.txt', type: 'text/plain', content: Buffer.from('just some text, not a document') }]);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('UNSUPPORTED_FILE_TYPE');
    expect(readdirSync(ctx.uploadDirectory)).toEqual([]);
    expect((await ctx.get('/api/chat/state')).json().state.evidenceRequest).toMatchObject({ status: 'OPEN', attemptCount: 0 });
  });

  it('a document that is not an Emirates ID, Trade License, Establishment Card or POA/MOA is refused with a clear code', async () => {
    const ctx = await start();
    await ctx.post('/api/chat', { message: intro('fatima-al-noor') });
    const response = await ctx.attach('/api/chat/evidence', [{ name: 'menu.pdf', type: 'application/pdf', content: (await import('@sbo/testkit')).makePdf('Restaurant menu: starters, mains and desserts for the whole family to enjoy.') }]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'DOCUMENT_TYPE_NOT_RECOGNISED', detail: 'menu.pdf' });
  });

  it('answers 409 when there is no open document request, and 400 without a file', async () => {
    const ctx = await start();
    expect((await ctx.attach('/api/chat/evidence', ctx.pdfs('fatima-al-noor'))).json().error).toBe('NO_EVIDENCE_REQUEST_PENDING');
    await ctx.post('/api/chat', { message: intro('fatima-al-noor') });
    expect((await ctx.attach('/api/chat/evidence', [], { message: 'here is my licence number' })).json().error).toBe('EVIDENCE_FILE_REQUIRED');
  });

  it('rejects more than three files, and a file over the size limit', async () => {
    const ctx = await start({ maxUploadBytes: 2048 });
    await ctx.post('/api/chat', { message: intro('fatima-al-noor') });
    const one = ctx.pdfs('fatima-al-noor')[0]!;
    expect((await ctx.attach('/api/chat/evidence', [one, one, one, one])).json().error).toBe('TOO_MANY_FILES');
    const big = await ctx.attach('/api/chat/evidence', [{ name: 'big.pdf', type: 'application/pdf', content: Buffer.alloc(4096, 65) }]);
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('FILE_TOO_LARGE');
  });

  it('the stored copy lives outside any public root under a generated name', async () => {
    const ctx = await start();
    await ctx.post('/api/chat', { message: intro('fatima-al-noor') });
    await ctx.attach('/api/chat/evidence', ctx.pdfs('fatima-al-noor'));
    const stored = readdirSync(ctx.uploadDirectory);
    expect(stored).toHaveLength(3);
    for (const name of stored) { expect(name).toMatch(/^[0-9a-f-]{36}-[A-Za-z0-9._-]+$/); expect(readFileSync(join(ctx.uploadDirectory, name)).subarray(0, 5).toString()).toBe('%PDF-'); }
    expect(existsSync(join(ctx.uploadDirectory, '..', 'emirates-id.pdf'))).toBe(false);
  });

  it('per-request upload route: one document for an explicit request; the stored request row is authoritative', async () => {
    const ctx = await start();
    const opened = (await ctx.post('/api/chat', { message: intro('fatima-al-noor') })).json();
    const id = opened.evidenceRequest.evidenceRequestId as string;
    expect((await ctx.get(`/api/evidence/${id}?case_run_id=${opened.caseRunId}`)).json()).toMatchObject({ uploadAllowed: true, status: 'OPEN' });
    expect((await ctx.get(`/api/evidence/${id}?case_run_id=AUTH-999`)).json()).toMatchObject({ uploadAllowed: false, rejectionReason: 'CASE_RUN_ID_MISMATCH' });
    expect((await ctx.get('/api/evidence/EVID-NOPE')).json()).toMatchObject({ uploadAllowed: false, rejectionReason: 'EVIDENCE_REQUEST_NOT_FOUND' });
    const [eid] = ctx.pdfs('fatima-al-noor');
    const done = await ctx.attach(`/api/evidence/${id}/upload`, [eid!], { case_run_id: opened.caseRunId });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'RECEIVED' });
    expect((await ctx.store.getEvidence(id))[0]).toMatchObject({ evidenceType: 'EMIRATES_ID', fileName: 'emirates-id.pdf', evidenceSource: 'FILE_UPLOAD' });
    const cancelled = await ctx.post(`/api/evidence/${id}/cancel`, { caseRunId: opened.caseRunId });
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED' });
  });

  it('the resolve route: missing documents → RETRY with what is still needed; all documents → the assessment resumes', async () => {
    const ctx = await start();
    const opened = (await ctx.post('/api/chat', { message: intro('fatima-al-noor') })).json();
    const id = opened.evidenceRequest.evidenceRequestId as string;
    const [eid] = ctx.pdfs('fatima-al-noor');
    await ctx.attach(`/api/evidence/${id}/upload`, [eid!]);
    const retry = (await ctx.post(`/api/evidence/${id}/resolve`, { caseRunId: opened.caseRunId, submissionVersion: 1 })).json();
    expect(retry).toMatchObject({ route: 'RETRY', resolutionStatus: 'INSUFFICIENT', requestStatus: 'INSUFFICIENT', attemptCount: 1, remainingGaps: ['Trade License of the business is still needed.', 'Establishment Card of the business is still needed.'] });
    for (const file of personaAttachments('fatima-al-noor', ['TRADE_LICENSE', 'ESTABLISHMENT_CARD'])) await submitDocumentEvidence(ctx.store, id, { fileName: file.fileName, mimeType: file.mimeType, storageUrl: 'x', extractedText: file.extractedText, allowReceived: true });
    const resolved = (await ctx.post(`/api/evidence/${id}/resolve`, { caseRunId: opened.caseRunId, submissionVersion: 1 })).json();
    expect(resolved).toMatchObject({ route: 'RESUMED', resolutionStatus: 'RESOLVED', requestStatus: 'ACCEPTED', resumedAssessment: { governedOutcome: 'APPROVE' } });
    expect((await ctx.post(`/api/evidence/${id}/resolve`, { caseRunId: opened.caseRunId, submissionVersion: 1 })).statusCode).toBe(409);
  });
});
describe('review dashboard and reopen API', () => {
  async function rejectedCase() {
    const ctx = await start();
    const opened = (await ctx.post('/api/chat', { message: intro('sara-desert-bloom') })).json();
    await ctx.attach('/api/chat/evidence', ctx.pdfs('sara-desert-bloom'));
    return { ...ctx, caseRunId: opened.caseRunId as string, reviewId: `REV-${opened.caseRunId}-1` };
  }

  it('lists every review on the dashboard and serves the detail with checks, documents and the root-cause analysis', async () => {
    const { get, caseRunId, reviewId } = await rejectedCase();
    const dashboard = (await get('/api/reviews')).json();
    expect(dashboard.reviews).toEqual([expect.objectContaining({ reviewId, caseRunId, businessName: 'Desert Bloom Cafe LLC', reviewStatus: 'PENDING_REJECTION_CONFIRMATION', agentRecommendation: 'REJECT', primaryReasonCode: 'TRADE_LICENSE_EXPIRED', reviewOpen: true })]);
    const detail = (await get(`/api/reviews/${reviewId}`)).json();
    expect(detail).toMatchObject({ review: { reviewId, reviewOpen: true, reopenAvailable: true, rootCause: { rootCause: expect.stringContaining('expired') } }, allowedDecisions: ['APPROVE', 'NEED_MORE_INFORMATION', 'REJECT'] });
    expect(detail.review.checks).toHaveLength(1);
    expect(detail.review.documents).toHaveLength(3);
    expect((await get('/api/reviews/REV-NOPE')).statusCode).toBe(404);
  });

  it('completes a review once, keeps it readable afterwards, and answers 409 on a duplicate submission', async () => {
    const { post, get, reviewId } = await rejectedCase();
    const body = { reviewerName: 'Riley', reviewerDecision: 'REJECT', reviewerComments: 'Confirmed: the licence has expired.', overrideReason: '' };
    const done = await post(`/api/reviews/${reviewId}/complete`, body);
    expect(done.json()).toMatchObject({ reviewStatus: 'COMPLETED', outcome: 'REJECT', targetQueue: 'CASE_CLOSURE', communication: { status: 'DRAFT' } });
    expect((await post(`/api/reviews/${reviewId}/complete`, { ...body, reviewerDecision: 'APPROVE' })).statusCode).toBe(409);
    expect((await get(`/api/reviews/${reviewId}`)).json().review).toMatchObject({ reviewOpen: false, reviewerName: 'Riley', reviewerDecision: 'REJECT' });
  });

  it('validates the reviewer submission and requires an override reason to overturn a rejection', async () => {
    const { post, reviewId } = await rejectedCase();
    expect((await post(`/api/reviews/${reviewId}/complete`, { reviewerName: '', reviewerDecision: 'APPROVE', reviewerComments: 'x' })).statusCode).toBe(422);
    expect((await post(`/api/reviews/${reviewId}/complete`, { reviewerName: 'R', reviewerDecision: 'RESOLVED_PASS', reviewerComments: 'x' })).statusCode).toBe(422);
    expect((await post(`/api/reviews/${reviewId}/complete`, { reviewerName: 'R', reviewerDecision: 'APPROVE', reviewerComments: 'x' })).json().error).toBe('OVERRIDE_REASON_REQUIRED');
  });

  it('reopening a rejected case creates a new version and puts the customer\'s chat back to "attach documents"', async () => {
    const { post, get, caseRunId, reviewId } = await rejectedCase();
    const reopened = await post(`/api/cases/${caseRunId}/reopen`, { reviewerName: 'Riley', comments: 'Send the renewed licence.' });
    expect(reopened.json()).toMatchObject({ originalCaseRunId: caseRunId, reopenedCaseRunId: `${caseRunId}-V2`, submissionVersion: 2, customerNotified: true });
    expect((await get('/api/reviews')).json().reviews[0]).toMatchObject({ reviewId, reviewStatus: 'CLOSED_REOPENED', reviewOpen: false });
    expect((await get(`/api/cases/${caseRunId}/status`)).json()).toMatchObject({ currentStatus: 'REOPENED_AS_NEW_VERSION' });
    const state = (await get('/api/chat/state')).json().state;
    expect(state).toMatchObject({ step: 'AWAITING_EVIDENCE', caseRunId: `${caseRunId}-V2` });
    expect(state.messages[0]).toContain('Send the renewed licence.');
    expect((await post(`/api/cases/${caseRunId}/reopen`, { reviewerName: 'Riley', comments: 'again' })).statusCode).toBe(409);
    expect((await post(`/api/cases/${caseRunId}/reopen`, { reviewerName: '', comments: '' })).statusCode).toBe(422);
  });

  it('the old resubmission, text-evidence and case-evaluate routes no longer exist', async () => {
    const { post } = await start();
    expect((await post('/api/resubmissions', {})).statusCode).toBe(404);
    expect((await post('/api/evidence/EVID-1/text', { text: 'x' })).statusCode).toBe(404);
    expect((await post('/api/cases/AUTH-101/evaluate', {})).statusCode).toBe(404);
  });
});

describe('error handling', () => {
  it('never leaks internal error details', async () => {
    class BrokenRepository extends InMemoryRepository { public override async getSession(): Promise<never> { throw new Error('connection string postgres://user:hunter2@db/secret failed'); } }
    const { post } = await start({ store: new BrokenRepository() });
    const response = await post('/api/chat', { message: 'hello' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'INTERNAL_PROCESSING_ERROR' });
    expect(response.body).not.toMatch(/hunter2|postgres:/);
  });
});

describe('startup environment validation', () => {
  const valid = { DATABASE_URL: 'postgres://sbo:sbo@localhost:5432/sbo', APP_BASE_URL: 'http://localhost:5173', SESSION_SECRET: 'x'.repeat(40), UPLOAD_DIR: './uploads', ANTHROPIC_API_KEY: 'k', CLAUDE_MODEL: 'some-model' };
  it('accepts a complete configuration and defaults PORT', () => { expect(loadEnv(valid)).toMatchObject({ PORT: 3000, AGENT_RUNTIME: 'claude', CLAUDE_MODEL: 'some-model' }); });
  it.each(['DATABASE_URL', 'APP_BASE_URL', 'SESSION_SECRET', 'UPLOAD_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL'])('fails fast when %s is missing', (key) => {
    expect(() => loadEnv({ ...valid, [key]: undefined })).toThrow(key);
  });
  it('rejects a short or placeholder SESSION_SECRET and placeholder credentials', () => {
    expect(() => loadEnv({ ...valid, SESSION_SECRET: 'short' })).toThrow('SESSION_SECRET');
    expect(() => loadEnv({ ...valid, SESSION_SECRET: 'replace-with-a-long-random-secret-value-xxxxxxxx' })).toThrow('placeholder');
    expect(() => loadEnv({ ...valid, ANTHROPIC_API_KEY: 'replace-with-a-valid-key' })).toThrow('ANTHROPIC_API_KEY');
  });
  it('allows the deterministic runtime without model credentials', () => { expect(loadEnv({ ...valid, AGENT_RUNTIME: 'deterministic', ANTHROPIC_API_KEY: undefined, CLAUDE_MODEL: undefined }).AGENT_RUNTIME).toBe('deterministic'); });
  it('error output never echoes secret values', () => {
    try { loadEnv({ ...valid, SESSION_SECRET: 'short-secret-value' }); } catch (error) { expect(String(error)).not.toContain('short-secret-value'); }
  });
});
