export class ApiError extends Error {
  public constructor(public readonly status: number, public readonly code: string, public readonly detail?: string) { super(code); }
}

let csrfToken = '';
let sessionId = '';

export async function ensureSession(): Promise<{ sessionId: string }> {
  if (!csrfToken) {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    const body = await response.json() as { csrfToken: string; sessionId: string };
    csrfToken = body.csrfToken;
    sessionId = body.sessionId;
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
  const messages: Record<string, string> = {
    CSRF_VALIDATION_FAILED: 'Your session expired. Refresh the page and try again.',
    RATE_LIMITED: 'Too many requests. Please wait a minute and try again.',
    VALIDATION_FAILED: 'Please check the highlighted fields and try again.',
    REVIEW_NOT_FOUND: 'The supplied Review ID could not be located.',
    REVIEW_ALREADY_COMPLETED: 'This review has already been completed and cannot be submitted a second time.',
    CASE_NOT_FOUND: 'That synthetic case was not found.',
    EVIDENCE_REQUEST_NOT_FOUND: 'The evidence request could not be found.',
    EVIDENCE_REQUEST_NOT_OPEN: 'This evidence request is no longer open for submissions.',
    EVIDENCE_REQUEST_ID_NOT_SUPPLIED: 'No evidence request ID was supplied.',
    CASE_RUN_ID_MISMATCH: 'The case does not match the evidence request.',
    UNSUPPORTED_FILE_TYPE: 'Only PDF files are accepted.',
    PDF_TEXT_UNAVAILABLE: 'The PDF did not contain enough extractable text. Please upload a clear, text-based PDF. The evidence request remains open.',
    FILE_TOO_LARGE: 'The file is too large (limit 5 MB).',
    PDF_TOO_COMPLEX: 'The PDF is too large or complex to read safely (limit: 50 pages). Please upload a shorter text-based PDF. The evidence request remains open.',
    CASE_LOCKED: 'This case has already been reviewed or resubmitted, so it cannot be re-evaluated. An operator must reset the runtime state to run it again.',
    ORIGIN_NOT_ALLOWED: 'This page is not allowed to call the API from its current address.',
    OVERRIDE_REASON_REQUIRED: 'An override reason is required when changing a REJECT recommendation.',
    RESUBMISSION_NOT_ALLOWED: 'Only a case that previously returned NEED_MORE_INFORMATION can be resubmitted.',
    RESUBMISSION_ALREADY_CREATED: 'This case has already been resubmitted.',
    INVALID_REVISED_VERSION: 'The revised case does not represent a later version of the same logical case.',
    RESUBMISSION_CASE_NOT_FOUND: 'One of the supplied cases could not be found.',
    EVIDENCE_RESOLUTION_OUTPUT_INVALID: 'The evidence could not be assessed because of a system error. Your evidence attempt was not counted; please try again.',
    EVIDENCE_RESOLUTION_REQUIRES_MODEL: 'Evidence assessment requires the AI model, which is not configured.',
    NO_NEW_EVIDENCE_RECEIVED: 'There is no newly received evidence to assess.',
  };
  return messages[error.code] ?? 'The request could not be completed.';
}
