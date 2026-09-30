import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { acceptedFileTypesHint, extractDocumentText, type ExtractedDocument } from './documents.js';
import { type AgentRuntime } from '@sbo/agent-runtime';
import { ReopenInputSchema, ReviewCompletionInputSchema, featuredQueries, requestCategories, requestTypes, stages } from '@sbo/domain';
import { type Repository } from '@sbo/persistence';
import { buildChatResponse, cancelEvidenceRequest, completeHumanReview, describeChatState, getCaseStatus, getOperationsOverview, getReviewPackage, handleChatEvidenceUpload, handleChatMessage, listReviewDashboard, listScenarios, readEvidenceDocument, reopenCase, resolveEvidenceAndContinue, submitDocumentEvidence, validateEvidenceRequest, type ChatReply } from '@sbo/workflows';

export interface ApiConfig {
  appBaseUrl: string; sessionSecret: string; uploadDirectory: string; secureCookies?: boolean; maxUploadBytes?: number;
  /** Requests per minute per client: `global` for every route, `strict` for the public assessment / evidence / review POST routes. */
  rateLimit?: { global?: number; strict?: number; upload?: number };
  /**
   * Addresses / CIDRs of reverse proxies whose X-Forwarded-For is trusted (empty = ignore the header, use the socket address). The client
   * address is the first UNtrusted hop from the right, so a client-supplied X-Forwarded-For prefix cannot spoof the rate-limit key.
   */
  trustProxy?: string[];
}
export interface AppDependencies { repository: Repository; agentRuntime: AgentRuntime; config: ApiConfig; }

const caseParams = z.object({ caseRunId: z.string().regex(/^AUTH-\d{3}(?:-V\d+)?$/i) });
const evidenceParams = z.object({ evidenceRequestId: z.string().min(1).max(200) });
const reviewParams = z.object({ reviewId: z.string().min(1).max(200) });
const sessionCookie = 'sbo_session';
const csrfCookie = 'sbo_csrf';

/** Business-safe error codes → HTTP status. Anything else is an opaque 500 (no internals leaked). */
const errorStatus: Array<[RegExp, number]> = [
  [/^(CASE_NOT_FOUND|REVIEW_NOT_FOUND|EVIDENCE_REQUEST_NOT_FOUND|DECISION_NOT_FOUND)/, 404],
  [/^(REVIEW_ALREADY_COMPLETED|EVIDENCE_REQUEST_NOT_OPEN|EVIDENCE_REQUEST_NOT_READY_FOR_RESOLUTION|REOPEN_NOT_ALLOWED|NO_NEW_EVIDENCE_RECEIVED|CASE_LOCKED|NO_EVIDENCE_REQUEST_PENDING|CASE_ALREADY_EXISTS)/, 409],
  [/^(EVIDENCE_RESOLUTION)/, 502],
  [/^(INTAKE_CASE_LIMIT_REACHED)/, 503],
  [/^(EVIDENCE_REQUEST_ID_|CASE_RUN_ID_|SUBMISSION_VERSION_MISMATCH|EVIDENCE_RECORDS_NOT_FOUND|EVIDENCE_FILE_REQUIRED|UNSUPPORTED_FILE_TYPE|LEGACY_WORD_NOT_SUPPORTED|DOCUMENT_|TOO_MANY_FILES|OVERRIDE_REASON_REQUIRED|REVIEWER_|UNSUPPORTED_REVIEWER_DECISION|CASE_ID_NOT_SUPPORTED|FILE_TOO_LARGE)/, 400],
];

/** Only these codes may carry a `detail` back to the client: a user-supplied identifier or the (sanitised) name of the customer's own file. */
const detailCodes = new Set(['CASE_NOT_FOUND', 'UNSUPPORTED_REVIEWER_DECISION', 'UNSUPPORTED_FILE_TYPE', 'LEGACY_WORD_NOT_SUPPORTED', 'DOCUMENT_TEXT_UNAVAILABLE', 'DOCUMENT_TOO_COMPLEX', 'DOCUMENT_TYPE_NOT_RECOGNISED']);
/** Best-effort removal of key material / connection strings from anything written to server logs. */
export function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[redacted]').replace(/(postgres(?:ql)?:\/\/)[^\s@/]+@/gi, '$1[redacted]@').replace(/((?:api[_-]?key|secret|password|token)\s*[=:]\s*)\S+/gi, '$1[redacted]');
}

function caseParamsUpper(request: FastifyRequest): string { return caseParams.parse(request.params).caseRunId.toUpperCase(); }
function safeName(name: string): string { return basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'evidence.pdf'; }
function fieldValue(field: unknown): string | undefined {
  if (field && typeof field === 'object' && !Array.isArray(field) && 'value' in field) { const value = (field as { value?: unknown }).value; return value === undefined ? undefined : String(value); }
  return undefined;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { repository, agentRuntime, config } = dependencies;
  const maxUploadBytes = config.maxUploadBytes ?? 5 * 1024 * 1024;
  const trustProxy = config.trustProxy && config.trustProxy.length > 0 ? config.trustProxy : false;
  const app = Fastify({ trustProxy, logger: { level: process.env.NODE_ENV === 'test' ? 'silent' : 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'req.headers["x-csrf-token"]'] } });
  // The API only returns JSON: a locked-down CSP. (The static host that serves apps/web must send its own CSP.)
  await app.register(helmet, { contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } } });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(cors, { origin: config.appBaseUrl, credentials: true });
  await app.register(rateLimit, { max: config.rateLimit?.global ?? 120, timeWindow: '1 minute' });
  const maxFilesPerMessage = 3;
  await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: maxFilesPerMessage, fields: 10 } });

  const strict = { config: { rateLimit: { max: config.rateLimit?.strict ?? 20, timeWindow: '1 minute' } } };

  // CSRF: signed double-submit. The token is an HMAC of the server-signed session id, so an attacker-chosen cookie/header pair is rejected
  // (SEC-08), plus an Origin check on every state-changing request.
  const allowedOrigin = new URL(config.appBaseUrl).origin;
  const csrfFor = (session: string): string => createHmac('sha256', config.sessionSecret).update(`csrf:${session}`).digest('hex');
  const sameToken = (left: unknown, right: string): boolean => typeof left === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
  app.addHook('preHandler', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin && origin !== allowedOrigin) return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
    const signed = request.cookies[sessionCookie];
    const unsigned = signed ? request.unsignCookie(signed) : undefined;
    if (!unsigned?.valid || !unsigned.value) return reply.code(403).send({ error: 'CSRF_VALIDATION_FAILED' });
    const expected = csrfFor(unsigned.value);
    if (!sameToken(request.cookies[csrfCookie], expected) || !sameToken(request.headers['x-csrf-token'], expected)) return reply.code(403).send({ error: 'CSRF_VALIDATION_FAILED' });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(422).send({ error: 'VALIDATION_FAILED', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
    const err = error as { code?: string; message?: string; statusCode?: number };
    if (err.statusCode === 429) return reply.code(429).send({ error: 'RATE_LIMITED' });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'FILE_TOO_LARGE' });
    if (err.code === 'FST_FILES_LIMIT') return reply.code(400).send({ error: 'TOO_MANY_FILES' });
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') return reply.code(415).send({ error: 'UNSUPPORTED_MEDIA_TYPE' });
    const message = error instanceof Error ? error.message : '';
    const known = errorStatus.find(([pattern]) => pattern.test(message));
    if (known) {
      const code = message.split(':')[0] ?? 'ERROR';
      // SEC-05: never echo internal text (model / SDK / filesystem errors) — log it, redacted, and return the code only.
      if (known[1] >= 500 || code.startsWith('EVIDENCE_RESOLUTION')) request.log.warn({ code, message: redactSecrets(message).slice(0, 400) }, 'request failed');
      return reply.code(known[1]).send({ error: code, detail: detailCodes.has(code) && message.includes(':') ? message.slice(message.indexOf(':') + 1).slice(0, 100) : undefined });
    }
    // Any other framework-level client error (malformed JSON, bad multipart, ...) is reported as a generic 4xx without internals.
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'REQUEST_REJECTED' });
    request.log.error({ err: { message: redactSecrets(message).slice(0, 300) } }, 'unhandled error');
    return reply.code(500).send({ error: 'INTERNAL_PROCESSING_ERROR' });
  });

  function sessionId(request: FastifyRequest, reply: FastifyReply): string {
    const signed = request.cookies[sessionCookie];
    if (signed) { const unsigned = request.unsignCookie(signed); if (unsigned.valid && unsigned.value) return unsigned.value; }
    const id = randomUUID();
    reply.setCookie(sessionCookie, id, { signed: true, httpOnly: true, sameSite: 'strict', secure: config.secureCookies ?? false, path: '/' });
    return id;
  }

  /**
   * What the customer's browser may see. A recommended rejection is not final and is never communicated externally before a human confirms it,
   * so the outcome and reason code of a REJECT are masked here (the dashboard and the audit trail keep the truth).
   */
  const publicReply = (reply: ChatReply) => {
    if (reply.outcome?.governedOutcome !== 'REJECT' && reply.outcome?.provisionalOutcome !== 'REJECT') return { ...reply };
    const masked = reply.outcome.governedOutcome === 'REJECT';
    return { ...reply, outcome: { ...reply.outcome, governedOutcome: masked ? 'PENDING_CONFIRMATION' : reply.outcome.governedOutcome, primaryReasonCode: masked ? 'UNDER_REVIEW' : reply.outcome.primaryReasonCode, provisionalOutcome: reply.outcome.provisionalOutcome === 'REJECT' ? 'PENDING_CONFIRMATION' : reply.outcome.provisionalOutcome, governanceOverride: false } };
  };

  app.get('/health', async () => ({ status: 'ok', syntheticDataOnly: true }));

  app.get('/api/session', async (request, reply) => {
    const session = sessionId(request, reply);
    const token = csrfFor(session);
    reply.setCookie(csrfCookie, token, { httpOnly: false, sameSite: 'strict', secure: config.secureCookies ?? false, path: '/' });
    return { csrfToken: token, sessionId: session, syntheticDataOnly: true };
  });

  // The operating model and the customer-facing request catalog (categories, request types, ready-made questions).
  app.get('/api/catalog', async () => ({ stages, categories: requestCategories, requests: requestTypes, featuredQueries, syntheticDataDisclaimer: true }));
  app.get('/api/operations', async () => getOperationsOverview(repository));

  app.get('/api/cases', async () => {
    const cases = await repository.listCases();
    return { cases: cases.map((entry) => ({ caseRunId: entry.caseRunId, caseId: entry.caseId, submissionVersion: entry.submissionVersion, businessName: entry.businessName })), syntheticDataDisclaimer: true };
  });

  // Demo aid: the synthetic identities that match a scenario (so a tester knows whose name / company to introduce themselves with).
  app.get('/api/scenarios', async () => ({ scenarios: listScenarios(), acceptedFileTypes: acceptedFileTypesHint, maxFilesPerMessage, maxFileBytes: maxUploadBytes, syntheticDataDisclaimer: true }));

  // Chat message: intake (name + company) and replies while a document request is open.
  // What the conversation is waiting for (e.g. the customer returns after a reviewer reopened the case).
  app.get('/api/chat/state', async (request, reply) => ({ state: (await describeChatState(repository, sessionId(request, reply))) ?? null, syntheticDataDisclaimer: true }));
  app.post('/api/chat', strict, async (request, reply) => {
    const body = z.object({ message: z.string().max(10_000), intent: z.string().max(60).optional() }).parse(request.body);
    return publicReply(await handleChatMessage({ repository, agentRuntime, appBaseUrl: config.appBaseUrl }, { sessionId: sessionId(request, reply), message: body.message, intent: body.intent }));
  });
  app.get('/api/cases/:caseRunId/status', async (request) => getCaseStatus(repository, caseParamsUpper(request)));

  // Workflow 96 — form open + validation
  app.get('/api/evidence/:evidenceRequestId', async (request) => {
    const { evidenceRequestId } = evidenceParams.parse(request.params);
    const query = z.object({ case_run_id: z.string().max(100).optional() }).parse(request.query);
    const stored = await repository.getEvidenceRequest(evidenceRequestId);
    const validation = validateEvidenceRequest(stored, evidenceRequestId, query.case_run_id ?? '');
    return { uploadAllowed: validation.uploadAllowed, rejectionReason: validation.rejectionReason, caseRunId: validation.caseRunId, evidenceRequestId, status: stored?.status ?? '', requestedItems: stored?.requestedItems ?? [], customerMessage: stored?.customerMessage ?? '', syntheticDataDisclaimer: true };
  });
  // Uploads are the most expensive public routes (file buffering + document parsing / OCR): never more than 10/min/client unless rateLimit.upload is set explicitly (tests only).
  const uploadLimit = { config: { rateLimit: { max: config.rateLimit?.upload ?? Math.min(config.rateLimit?.strict ?? 20, 10), timeWindow: '1 minute' } } };

  /** Reads the customer's document: type from its bytes, then text. Throws a coded error (detail = the sanitised file name). */
  async function readDocument(bytes: Buffer, fileName: string): Promise<ExtractedDocument> {
    const label = safeName(fileName);
    let document: ExtractedDocument;
    try { document = await extractDocumentText(bytes); } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : 'UNSUPPORTED_FILE_TYPE'}:${label}`);
    }
    if (document.error) throw new Error(`${document.error}:${label}`);
    if (document.text.length < 20) throw new Error(`DOCUMENT_TEXT_UNAVAILABLE:${label}`);
    try { readEvidenceDocument(document.text); } catch { throw new Error(`DOCUMENT_TYPE_NOT_RECOGNISED:${label}`); }
    return document;
  }
  async function storeFile(bytes: Buffer, fileName: string): Promise<{ storedName: string; storedPath: string }> {
    const destination = resolve(config.uploadDirectory);
    await mkdir(destination, { recursive: true });
    const storedName = `${randomUUID()}-${safeName(fileName)}`;
    const storedPath = join(destination, storedName);
    await writeFile(storedPath, bytes, { flag: 'wx' });
    return { storedName, storedPath };
  }
  /** Collects up to three files (each buffered under the size limit) and the text fields of a multipart request. */
  async function readMultipart(request: FastifyRequest): Promise<{ files: Array<{ fileName: string; bytes: Buffer }>; fields: Record<string, string> }> {
    const files: Array<{ fileName: string; bytes: Buffer }> = [];
    const fields: Record<string, string> = {};
    for await (const part of request.parts()) {
      if (part.type === 'file') files.push({ fileName: part.filename, bytes: await part.toBuffer() });
      else if (typeof part.value === 'string') fields[part.fieldname] = part.value.slice(0, 10_000);
    }
    return { files, fields };
  }

  // Customer chat: answer an open document request by attaching documents in the SAME conversation (no separate upload page, nothing to type).
  app.post('/api/chat/evidence', uploadLimit, async (request, reply) => {
    const session = sessionId(request, reply);
    if ((await repository.getSession(session))?.step !== 'AWAITING_EVIDENCE') {
      for await (const part of request.parts()) if (part.type === 'file') part.file.resume();
      throw new Error('NO_EVIDENCE_REQUEST_PENDING');
    }
    const { files, fields } = await readMultipart(request);
    void fields; // typed text is never evidence
    if (files.length === 0) throw new Error('EVIDENCE_FILE_REQUIRED');
    // Read every file BEFORE storing or recording anything: one unreadable attachment rejects the whole message and nothing is kept.
    const documents = [];
    for (const file of files) documents.push({ file, document: await readDocument(file.bytes, file.fileName) });
    const storedPaths: string[] = [];
    try {
      const attached = [];
      for (const { file, document } of documents) {
        const stored = await storeFile(file.bytes, file.fileName);
        storedPaths.push(stored.storedPath);
        attached.push({ fileName: safeName(file.fileName), mimeType: document.mimeType, storageUrl: stored.storedName, extractedText: document.text });
      }
      return publicReply(await handleChatEvidenceUpload({ repository, agentRuntime, appBaseUrl: config.appBaseUrl }, { sessionId: session, files: attached }));
    } catch (error) {
      for (const path of storedPaths) await unlink(path).catch(() => undefined); // SEC-10: no orphaned files when the step is refused
      throw error;
    }
  });

  // Workflow 96 (source form route, kept for API parity): one file against an explicit evidence request.
  app.post('/api/evidence/:evidenceRequestId/upload', uploadLimit, async (request) => {
    const { evidenceRequestId } = evidenceParams.parse(request.params);
    const part = await request.file();
    if (!part) throw new Error('EVIDENCE_FILE_REQUIRED');
    // The stored request row is authoritative. Validate it BEFORE buffering the file (cheap rejection of closed / wrong requests)...
    const caseFrom = (fields: typeof part.fields): string => fieldValue(fields.caseRunId) ?? fieldValue(fields.case_run_id) ?? '';
    const early = validateEvidenceRequest(await repository.getEvidenceRequest(evidenceRequestId), evidenceRequestId, caseFrom(part.fields));
    if (!early.uploadAllowed) { part.file.resume(); throw new Error(early.rejectionReason); }
    const buffer = await part.toBuffer();
    // ...and again with the final field set, before anything is stored.
    const suppliedCaseRunId = caseFrom(part.fields);
    const validation = validateEvidenceRequest(await repository.getEvidenceRequest(evidenceRequestId), evidenceRequestId, suppliedCaseRunId);
    if (!validation.uploadAllowed) throw new Error(validation.rejectionReason);
    const document = await readDocument(buffer, part.filename);
    const stored = await storeFile(buffer, part.filename);
    try {
      const evidence = await submitDocumentEvidence(repository, evidenceRequestId, { caseRunId: suppliedCaseRunId || undefined, fileName: safeName(part.filename), mimeType: document.mimeType, storageUrl: stored.storedName, extractedText: document.text });
      return { evidenceId: evidence.evidenceId, status: evidence.validationStatus, extractedCharacterCount: document.text.length, syntheticDataDisclaimer: true };
    } catch (error) {
      await unlink(stored.storedPath).catch(() => undefined); // SEC-10: no orphaned file when the database step is refused (e.g. a racing upload)
      throw error;
    }
  });
  // Workflow 95 (+ Workflow 03 routing)
  app.post('/api/evidence/:evidenceRequestId/resolve', strict, async (request, reply) => {
    const { evidenceRequestId } = evidenceParams.parse(request.params);
    const body = z.object({ caseRunId: z.string().min(1), submissionVersion: z.number().int().positive() }).parse(request.body);
    const continuation = await resolveEvidenceAndContinue(repository, agentRuntime, evidenceRequestId, body.caseRunId, body.submissionVersion, sessionId(request, reply));
    const resumed = continuation.resumedAssessment;
    const caseRecord = resumed ? await repository.getCase(resumed.decision.caseRunId) : undefined;
    return {
      route: continuation.route, resolutionStatus: continuation.resolution.resolutionStatus, requestStatus: continuation.resolution.request.status, attemptCount: continuation.resolution.request.attemptCount, maxAttempts: continuation.resolution.request.maxAttempts, remainingGaps: continuation.remainingGaps, reviewId: continuation.review?.reviewId ?? null,
      resumedAssessment: resumed ? { governedOutcome: resumed.decision.outcome === 'REJECT' ? 'PENDING_CONFIRMATION' : resumed.decision.outcome, primaryReasonCode: resumed.decision.outcome === 'REJECT' ? 'UNDER_REVIEW' : resumed.decision.primaryReasonCode, toolsCalled: resumed.trace.map((step) => step.tool), curated: buildChatResponse({ decision: resumed.decision, businessName: caseRecord?.businessName ?? '', representativeName: caseRecord?.representativeName ?? '' }).output } : null,
      syntheticDataDisclaimer: true,
    };
  });
  app.post('/api/evidence/:evidenceRequestId/cancel', strict, async (request) => {
    const { evidenceRequestId } = evidenceParams.parse(request.params);
    const body = z.object({ caseRunId: z.string().optional() }).parse(request.body ?? {});
    const cancelled = await cancelEvidenceRequest(repository, evidenceRequestId, body.caseRunId);
    return { evidenceRequestId: cancelled.evidenceRequestId, status: cancelled.status, syntheticDataDisclaimer: true };
  });

  // Review ID dashboard + review detail + completion + reopen
  app.get('/api/reviews', async () => ({ reviews: await listReviewDashboard(repository), syntheticDataDisclaimer: true }));
  app.get('/api/reviews/:reviewId', async (request) => {
    const { reviewId } = reviewParams.parse(request.params);
    return { review: await getReviewPackage(repository, reviewId), allowedDecisions: ['APPROVE', 'NEED_MORE_INFORMATION', 'REJECT'], syntheticDataDisclaimer: true };
  });
  app.post('/api/reviews/:reviewId/complete', strict, async (request) => {
    const { reviewId } = reviewParams.parse(request.params);
    const input = ReviewCompletionInputSchema.parse(request.body);
    const result = await completeHumanReview(repository, reviewId, input);
    return { reviewId, reviewStatus: result.review.reviewStatus, outcome: result.decision.outcome, primaryReasonCode: result.decision.primaryReasonCode, nextAction: result.decision.nextAction, targetQueue: result.decision.targetQueue, communication: { subject: result.communication.subject, body: result.communication.body, status: result.communication.status }, syntheticDataDisclaimer: true };
  });
  // A rejected / incomplete / manual-review case is reopened from the dashboard: a new version, and the customer's chat asks for documents again.
  app.post('/api/cases/:caseRunId/reopen', strict, async (request) => {
    const { caseRunId } = caseParams.parse(request.params);
    const input = ReopenInputSchema.parse(request.body);
    const result = await reopenCase(repository, { caseRunId: caseRunId.toUpperCase(), reviewerName: input.reviewerName, comments: input.comments });
    return { originalCaseRunId: result.original.caseRunId, reopenedCaseRunId: result.reopened.caseRunId, submissionVersion: result.reopened.submissionVersion, evidenceRequestId: result.request.evidenceRequestId, customerNotified: result.customerNotified, syntheticDataDisclaimer: true };
  });
  return app;
}
