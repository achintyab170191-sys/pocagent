export class ApiError extends Error {
  public constructor(public readonly status: number, public readonly code: string, public readonly detail?: string) { super(code); }
}

let csrfToken = '';
let sessionId = '';

let pending: Promise<void> | undefined;

/** One in-flight session request at a time: concurrent calls on page load must share a single cookie/CSRF pair. */
export async function ensureSession(): Promise<{ sessionId: string }> {
  if (!csrfToken) {
    pending ??= fetch('/api/session', { credentials: 'same-origin' })
      .then((response) => response.json() as Promise<{ csrfToken: string; sessionId: string }>)
      .then((body) => { csrfToken = body.csrfToken; sessionId = body.sessionId; })
      .finally(() => { pending = undefined; });
    await pending;
  }
  return { sessionId };
}

interface RequestOptions { method?: 'GET' | 'POST'; body?: unknown; form?: FormData; }

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  await ensureSession();
  const method = options.method ?? (options.body || options.form ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (method === 'POST') headers['x-csrf-token'] = csrfToken;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, credentials: 'same-origin', headers, body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined) });
  const text = await response.text();
  let payload: unknown = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (!response.ok) {
    const error = payload as { error?: string; detail?: string };
    throw new ApiError(response.status, error.error ?? `HTTP_${response.status}`, error.detail);
  }
  return payload as T;
}

/** Plain-language messages for the business error codes the API returns. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  const file = error.detail ? ` (${error.detail})` : '';
  const fileMessages: Record<string, string> = {
    UNSUPPORTED_FILE_TYPE: `That file type isn't supported${file}. Please attach a PDF, Word (.docx) or image file.`,
    LEGACY_WORD_NOT_SUPPORTED: `Old-style Word (.doc) files aren't supported${file}. Please save it as .docx or PDF and attach it again.`,
    DOCUMENT_TEXT_UNAVAILABLE: `I couldn't read enough text from that file${file}. Please attach a clearer document or photo. Your request remains open.`,
    DOCUMENT_TOO_COMPLEX: `That file is too large or complex to read safely${file}. Please attach a shorter document (up to 50 pages). Your request remains open.`,
    DOCUMENT_TYPE_NOT_RECOGNISED: `I couldn't recognise that file${file} as an Emirates ID, Trade License, Establishment Card or POA/MOA. Please attach one of those documents. Your request remains open.`,
  };
  if (fileMessages[error.code]) return fileMessages[error.code]!;
  const messages: Record<string, string> = {
    CSRF_VALIDATION_FAILED: 'Your session expired. Refresh the page and try again.',
    RATE_LIMITED: 'Too many requests. Please wait a minute and try again.',
    VALIDATION_FAILED: 'Please check the highlighted fields and try again.',
    REVIEW_NOT_FOUND: 'The supplied Review ID could not be located.',
    REVIEW_ALREADY_COMPLETED: 'This review has already been completed and cannot be submitted a second time.',
    DECISION_NOT_FOUND: 'No decision exists for this case yet (no checks were run), so it can only be reopened.',
    CASE_NOT_FOUND: 'That synthetic case was not found.',
    EVIDENCE_REQUEST_NOT_FOUND: 'The document request could not be found.',
    EVIDENCE_REQUEST_NOT_OPEN: 'This document request is no longer open for submissions.',
    EVIDENCE_REQUEST_ID_NOT_SUPPLIED: 'No document request ID was supplied.',
    CASE_RUN_ID_MISMATCH: 'The case does not match the document request.',
    NO_EVIDENCE_REQUEST_PENDING: 'There is no open document request in this conversation, so there is nothing to attach a file to.',
    TOO_MANY_FILES: 'You can attach up to 3 files at a time.',
    EVIDENCE_FILE_REQUIRED: 'Please attach a document.',
    FILE_TOO_LARGE: 'The file is too large (limit 5 MB).',
    CASE_LOCKED: 'This case has already been reviewed or reopened, so it cannot be re-evaluated. An operator must reset the runtime state to run it again.',
    ORIGIN_NOT_ALLOWED: 'This page is not allowed to call the API from its current address.',
    OVERRIDE_REASON_REQUIRED: 'An override reason is required when changing a REJECT recommendation.',
    REVIEWER_NAME_REQUIRED: 'Please enter the reviewer name.',
    REVIEWER_COMMENTS_REQUIRED: 'Please enter a comment.',
    REOPEN_NOT_ALLOWED: 'This case cannot be reopened: it is approved, already reopened, or has no open review.',
    NO_NEW_EVIDENCE_RECEIVED: 'There is no newly received document to assess.',
  };
  return messages[error.code] ?? 'The request could not be completed.';
}
