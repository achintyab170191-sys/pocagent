# Security review

**Scope:** API (`apps/api`), web client (`apps/web`), agent runtime, persistence, uploads, dependencies. All data is synthetic.
**Method:** an independent reviewer (a fresh agent with the charter in `.claude/agents/security-reviewer.md`, read-only apart from scratch probes) reviewed the code after the parity tests passed and reproduced candidate findings with in-memory `app.inject` probes. Its report was treated as untrusted input: every finding was triaged against the code, the fixes are pinned by regression tests in `tests/security.test.ts` (and `tests/sql.integration.test.ts`), and anything not fixed is listed below with the reason.
**Independence caveat:** I did not re-run the reviewer's original probes; the fixes are verified by new tests written from its descriptions. Its measurements (e.g. 69 s event-loop stall, ~1000:1 inflation) are reported as its claims. The agent model is **not exercised live** in this build, so prompt-injection resistance of the model itself was reviewed by code reading only.

## Summary

| ID | Finding | Severity | Status now | Evidence |
| --- | --- | --- | --- | --- |
| SEC-01 | PDF parsing unbounded (event-loop stall, decompression bomb) | High | **Mitigated** (residual: see below) | `security.test.ts › SEC-01` |
| SEC-02 | Anonymous re-evaluation overwrites a human-reviewed decision | High | **Fixed as a documented deviation** (source allows it) | `security.test.ts › SEC-02`, docs/07 G-27 |
| SEC-03 | Parallel `resolve` under-counts attempts / double-resumes; parallel resubmission passes twice | Medium | **Fixed** | `security.test.ts › SEC-03`, SQL suite, docs/07 G-28 |
| SEC-04 | A model `RESOLVED` verdict is the only gate on evidence | Medium | **Partly mitigated / by design** | `security.test.ts › SEC-04` |
| SEC-05 | Error handler echoes raw internal messages | Medium | **Fixed** | `security.test.ts › SEC-05` |
| SEC-06 | Unauthenticated review / evidence / status endpoints, guessable IDs | Medium | **By design (source parity) — open risk** | below |
| SEC-07 | `drizzle-orm` (GHSA-gpj5-g38j-94v9) high-severity, unused | Low | **Fixed** (removed; `npm audit --omit=dev`: 0) | package.json |
| SEC-08 | CSRF token not bound to the session | Low | **Fixed** (HMAC of session + Origin check) | `security.test.ts › SEC-08` |
| SEC-09 | Rate limits per direct-peer IP; no `trustProxy`; upload budget too high | Low | **Fixed** (explicit trusted-proxy list; upload ≤ 10/min) | `security.test.ts › SEC-09` |
| SEC-10 | Upload written before the DB step, no cleanup, body buffered before status check | Low | **Fixed** | `security.test.ts › SEC-10` |
| SEC-11 | Duplicate OPEN evidence requests; escalation could reset a COMPLETED review | Low | **Partly fixed** (review reset fixed; duplicates are source behaviour) | `security.test.ts › SEC-03` (review), status warning |
| SEC-12 | Compose exposes Postgres on all interfaces; agent subprocess inherits all env | Low | **Fixed** | `security.test.ts › SEC-12`, docker-compose.yml |
| SEC-13 | Customer surface shows provisional outcome / tool trace | Info | **Accepted** (required visible trace) | below |
| SEC-14 | CSP allows `style-src 'unsafe-inline'` | Info | **Fixed** for the API (JSON-only CSP) | `api.test.ts › sets security headers` |

## What changed, by finding

**Update (G-32):** the same worker/limit approach now covers DOCX (zip central-directory entry and inflated-size limits, mammoth in a worker) and images (magic-byte sniff, pixel and side caps, 2-slot OCR semaphore, timeout, confidence floor); files are identified by content, never by name or declared type. Residual risk: OCR CPU time is bounded by the timeout and concurrency cap only.

**SEC-01.** `apps/api/src/pdf.ts` runs pdf.js in a worker thread with an 8 s timeout, a 256 MB JS-heap cap, a raw-bytes page-count pre-check (`/Count`) and a 50-page / 200 000-character cap. Hostile PDFs return `PDF_TOO_COMPLEX` (HTTP 400) and store nothing; the event loop stays responsive (tested). *Residual:* pdf.js inflates streams into typed arrays that `resourceLimits` does not cap, so a flate bomb can allocate memory for up to the 8 s timeout. Mitigations in place/recommended: 5 MB upload cap, 10 uploads/min/client, `mem_limit: 1g` in the compose file; for production run the API under a container/cgroup memory limit and consider a child process with a byte-capped inflater.

**SEC-02.** The source lets any chat message re-evaluate any case (reset runtime rows → re-finalize). That destroyed a reviewer's decision in the reviewer's probe. `evaluateCase` now refuses (`CASE_LOCKED`, 409; the chat says so) when the case has a COMPLETED review or is `SUPERSEDED_BY_RESUBMISSION`; an operator resets runtime state deliberately (`npm run reset:runtime`). This is a *deviation from source behaviour*, recorded as docs/07 G-27 and in the traceability matrix; if the process owner wants the original behaviour it is a one-line removal, but it should then be behind authentication.

**SEC-03.** Evidence resolution, resubmission, evaluation and resume each run as one transaction. PostgreSQL reads of the evidence request, decision and runtime case take `FOR UPDATE` inside a transaction (review rows already did); the in-memory store serialises top-level transactions and lets nested calls join. Parallel resolves now produce one model call, one attempt, one resume. *Trade-off:* the model call happens inside a database transaction (a connection is held for its duration). Acceptable for the POC; a production version should claim the request with an atomic status update, release the lock, call the model, then commit the result with a compare-and-swap.

**SEC-04 (partly).** `RESOLVED` must now cite at least one supported fact (source rule 9), enforced in both schemas. The larger point stands and is *by design*: the model's schema-validated verdict is what turns a check into PASS, with no human in that path (the same as the source). Recommended before any real use: deterministic cross-checks of the cited facts against the case record, and a human-review gate for identity/authority flips.

**SEC-05.** Error `detail` is only ever returned for `CASE_NOT_FOUND` and `UNSUPPORTED_REVIEWER_DECISION` (user-supplied identifiers). Model/SDK failures return the bare code (`EVIDENCE_RESOLUTION_OUTPUT_INVALID`, 502); the full message is logged after `redactSecrets` (API keys, connection strings, `password=`-style pairs).

**SEC-08 / SEC-09.** CSRF token = `HMAC-SHA256(SESSION_SECRET, "csrf:" + sessionId)`, compared in constant time against both the cookie and the `x-csrf-token` header; state-changing requests also require an allowed `Origin` when one is sent. `TRUST_PROXY` is an explicit list of proxy addresses/CIDRs (empty = ignore `X-Forwarded-For`); the client address is the first *untrusted* hop from the right, so a client-supplied prefix cannot spoof the limiter. *Not done:* a shared strict bucket across all model-invoking routes and per-session/per-case limits (each route has its own per-IP budget).

**SEC-10 / SEC-11 / SEC-12.** Request validity is checked before the file body is buffered and again with the final fields; the stored file is deleted if the database step refuses it. An evidence escalation never resets a COMPLETED review to PENDING (it takes `…-EVIDENCE-1-2`). The Postgres port is bound to loopback; the agent subprocess gets the parent environment minus `DATABASE_URL`, `SESSION_SECRET` (the API key is passed explicitly).

## Accepted / open risks (not fixed on purpose)

| ID | Why | Recommendation |
| --- | --- | --- |
| SEC-06 | The source portals (review, evidence upload, status, resubmission) are open forms; reviewer identity is a free-text field. Anyone who can reach the API can complete a review, cancel or exhaust another user's evidence request (three junk texts + resolve), enumerate `/api/cases`, or trigger model spend. IDs (`REV-AUTH-004-1`, `EVID-<case>-V<n>-<ms>`) are predictable. **Must not be exposed beyond a trusted demo network.** | SSO + roles for `/review` and `/status`; unguessable capability tokens in evidence links; bind evidence actions to the creating session (`sessionId` is already stored on the request); take the reviewer identity from the session (docs/post-parity-enhancements.md §3). |
| SEC-11 (duplicates) | Re-evaluating a case with an OPEN request creates another OPEN request (source behaviour). The status page warns about it. | Reuse or cancel the older request when a new one is created. |
| SEC-13 | The chat reply shows the governed outcome, reason code, whether the agent's recommendation was overridden, and the tool names called — the brief requires a visible trace. It reveals no prompts, tool JSON or rules. It does give a probing client an oracle for "did the model disagree with policy". | If the customer channel is ever untrusted, show the trace to reviewers only. |
| Web CSP | The API now sends a JSON-only CSP; the static host that serves `apps/web` must send its own (`default-src 'self'`, hashed/nonce styles). | Configure at the web host / CDN. |
| Dev tooling | `npm audit` (dev deps) lists 2 moderate advisories in vitest's mocker; they are not in the shipped bundle. | Upgrade vitest when convenient. |

## Checked and sound (reviewer + own checks)

Zod validation on every body/param (422); case IDs regex-constrained; cookies signed/HttpOnly/SameSite=Strict, `Secure` in production; upload MIME + `%PDF-` magic, generated UUID names, `basename` + allow-list sanitising, `wx` writes, path traversal neutralised (tested); multipart limits (5 MB, 1 file, 10 fields); Postgres queries parameterised (the only `sql.unsafe` calls use fixed constants or quoted CSV header names and are not reachable from HTTP); the agent has no built-in tools (`tools: []`, `dontAsk`, no setting sources, no session persistence) and only the seven guarded tools; the toolbox refuses repeated, out-of-order and post-terminal calls; the Finalizer is deterministic and imports no model code (tested); customer output is built from a reason-text map and curated fields; the web Markdown renderer emits React nodes (no `innerHTML`); no secrets or model names in source (tested) and `.env` is git-ignored; logger redacts cookie / authorization / CSRF headers.

## Re-running

```bash
npx vitest run tests/security.test.ts        # regression tests for every fixed finding
npm audit --omit=dev                          # production dependencies: 0 vulnerabilities at review time
```
