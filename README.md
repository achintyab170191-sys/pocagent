# SBO agentic POC — n8n → TypeScript / Claude Agent SDK

A parity-first re-implementation of an n8n proof of concept that decides whether a **new authorised representative** may be added for a business. A Claude-powered Super Agent (SBO.02) calls seven deterministic specialist checks; a **deterministic finalizer** — never the model — issues the governed outcome (`APPROVE`, `REJECT`, `NEED_MORE_INFORMATION`, `MANUAL_REVIEW`). Evidence loops, human review, versioned resubmission, communications drafts and a full audit trail are included.

> **All data is synthetic.** No production system is read or written and no message is sent. Communications are drafts.

The original n8n exports (`NN - *.json`) and Data Table exports (`dt_*.csv`) in the repository root are the source of truth and are preserved unchanged (`npm run verify:sources`).

## Architecture

```
Chat / API ─▶ SBO.02 Super Agent (Claude Agent SDK — provisional recommendation only)
                └─ guarded toolbox ─▶ Document · Business · Identity · Authority · System data · Financial · Final verification
                                        └─ persisted runtime results  (unique: case_run_id + submission_version + check_type)
            ─▶ Deterministic Finalizer (Workflow 90 — no LLM)
                └─ decision · draft communication · runtime case · audit   (one transaction)
            ─▶ Evidence loop (96 attachments in chat → 95 resolution → resume) · Human review (91) · Resubmission (92) · Case status
```

Monorepo: `apps/api` (Fastify) · `apps/web` (React + Vite) · `packages/{domain,governance,persistence,workflows,agent-runtime,testkit}` · `scripts/` · `docs/`. ORM choice: no ORM — the `postgres` driver with hand-written SQL behind a `Repository` interface, because the schema is small, must be identical for the in-memory test double and PostgreSQL, and the key/constraint behaviour is the thing under test.

## Set up and run

Prerequisites: Node.js 20+ (developed on 24), npm; Docker only if you want a PostgreSQL server.

```bash
npm install
cp .env.example .env        # then edit: ANTHROPIC_API_KEY, CLAUDE_MODEL, SESSION_SECRET (>= 32 chars)
docker compose up -d postgres
npm run db:migrate
npm run db:seed             # static reference fixtures only (runtime tables stay empty)
npm run dev                 # API http://localhost:3000, web http://localhost:5173
```

No model key yet? Set `AGENT_RUNTIME=deterministic` in `.env`: the governed tool sequence and the finalizer run without a model (AUTH-001…010 first-pass decisions work); the **evidence-resolution step needs the model** and fails closed without it.

| Command | What it does |
| --- | --- |
| `npm run typecheck` / `lint` | TypeScript strict (API/packages/tests + web) / ESLint (no `any` in contracts) |
| `npm test` | Unit + in-memory suites (vitest) |
| `npm run test:integration` | SQL suite on embedded PostgreSQL (PGlite) — migrations, constraints, importers, repositories, transactions |
| `npm run test:e2e` | Playwright browser suite. Uses the installed Edge; `PW_CHANNEL= npx playwright test` for bundled Chromium after `npx playwright install chromium` |
| `npm run build` | Typecheck + API bundle (`dist/api/server.mjs`) + web build |
| `npm run db:migrate` · `db:seed` | Schema · static fixtures into schema `source` (exact source column names) |
| `npm run import:sources [-- --history --verify]` | Re-import fixtures; optionally exported runtime rows into schema `history` (reference only) |
| `npm run reset:runtime` | Delete **only** runtime state |
| `npm run docs:traceability` | Rebuild `docs/05` (fails on any unmapped node or missing test) |
| `npm run report:parity` | Run all suites and write `artifacts/parity-report.json` + `docs/parity-report.md` |
| `npm run verify:sources` | SHA-256 check of the preserved uploads |

## Demo (web app, `npm run dev`, open http://localhost:5173)

**Start as a customer.** Open the chat and say who you are and which company you represent (e.g. *"My name is Hana Rangi and I represent Kauri Harbour Demo Digital Limited"*). A case (AUTH-101...) is opened and assessed. If evidence is needed, answer in the same window: type, attach PDF / Word (.docx) / image files with the paperclip (or drag them in), or both - there is nothing to type like UPLOAD. Results come from matched synthetic scenarios (docs/07 G-33); a new name/company gets its own synthetic case, backed by a clean synthetic profile, and is assessed end to end (docs/07 G-35 - simulated, not a real verification).

Every screen shows the synthetic-data banner. The chat has quick buttons for the 11 cases.

| Case | Do this | You should see |
| --- | --- | --- |
| **AUTH-001** | Chat → click `AUTH-001` | *Eligible to proceed* — 7 checks passed, tool trace `Document Checks → … → Final Verification`, governed outcome APPROVE / `ALL_CHECKS_PASSED`. |
| **AUTH-003** | Chat → `AUTH-003` (demo shortcut) → simply type e.g. *"The signed authority letter grants account management, service ordering, plan changes and contract approval."* | First: *Additional evidence required* (authority scope ambiguous) with an evidence request and a prompt to type an answer and/or attach documents (PDF, Word, images) in the same chat window; nothing else to type. After the evidence: the assessment **resumes from the next incomplete check without re-running passed ones**. Note (source fact, docs/07 G-12): the fixture's downstream rows are `NOT_RUN`, so the governed result is `MANUAL_REVIEW / MANDATORY_CHECKS_INCOMPLETE`. Try attaching a PDF, .docx or image with the paperclip instead of typing. (Needs `AGENT_RUNTIME=claude`.) |
| **AUTH-005** | Chat → `AUTH-005`; then *Human review* → `REV-AUTH-005-1` | *Specialist review required*: conflicting CRM legal names, route *Customer Data Reconciliation*. Complete the review once (`NEED_MORE_INFORMATION` + comment); a second attempt is refused. *Case status* → `AUTH-005` shows review, decision, draft communication. |
| **AUTH-010** | Chat → `AUTH-010` | *Policy review required* — a TBD credit rule triggers control `CTRL-001 / TBD_POLICY`; never an automated approval or rejection. |
| AUTH-008 | Chat → `AUTH-008-V1`, then *Resubmission* → V1 → V2 | V1 needs more information; V2 is approved; V1 becomes `SUPERSEDED_BY_RESUBMISSION`. |

## What is where

| Need | Read |
| --- | --- |
| Source files, checksums, workflow & table inventory | `docs/01-source-inventory.md` |
| Workflow call graph, table readers/writers | `docs/02-workflow-graph.md` |
| Every node | `docs/03-node-catalog.md`, `artifacts/source-node-catalog.json` |
| Tables, columns, types, keys (from real upsert filters), source gaps in schemas | `docs/04-data-dictionary.md` |
| **Node → code → test matrix** (229 nodes, generated & validated) | `docs/05-n8n-to-code-traceability.md` |
| Case / evidence / review state machines | `docs/06-state-machine-specification.md` |
| **Every gap, defect and brief-vs-source conflict, and platform differences** | `docs/07-source-gaps-and-conflicts.md` |
| Method and limits of verification | `docs/08-parity-plan.md` |
| Test results and parity % | `docs/parity-report.md`, `artifacts/parity-report.json` |
| Security findings | `docs/security-review.md` |
| Improvements deliberately not built | `docs/post-parity-enhancements.md` |
| Rules for contributors / agents | `CLAUDE.md`, `.claude/agents/` |

## API ↔ n8n entry points

| n8n trigger | Route |
| --- | --- |
| Agentic Chat (03) | `POST /api/chat`, `POST /api/cases/:caseRunId/{evaluate,messages}` |
| Case status (93 — absent, adapter) | `GET /api/cases/:caseRunId/status` |
| Customer Evidence Upload form (96) | `GET /api/evidence/:id` (validate), `POST /api/chat/evidence` (attachments from the chat window, up to 3 files), `POST /api/evidence/:id/upload`, `POST /api/evidence/:id/text`, `GET /api/scenarios`, `POST /api/evidence/:id/cancel` |
| Evidence Resolution (95, via 03) | `POST /api/evidence/:id/resolve` |
| Human Review form (91) | `GET /api/reviews/:reviewId`, `POST /api/reviews/:reviewId/complete` |
| Resubmission form (92) | `POST /api/resubmissions` |
| — | `GET /api/session` (CSRF token + server-issued conversation session), `GET /api/cases`, `GET /health` |

State-changing routes require the double-submit CSRF header; assessment/evidence/review POSTs are rate-limited; attachments are PDF, Word (.docx) or image files identified by magic bytes (5 MB each, up to 3 per message; legacy .doc is refused; images are read offline with OCR), stored outside any web root under generated names.

## Honest limits

- **No live Claude call has been made** in this build (no API key was available). The SDK integration is tested against an injected SDK double; deterministic guards (toolbox, Zod validation, finalizer) do not depend on model behaviour.
- **No PostgreSQL server or Docker** was available: SQL is tested on embedded PostgreSQL 18 (PGlite) via the same driver. `docker-compose.yml`/`Dockerfile` are provided but were not run.
- Git was not available on the authoring machine, so nothing was committed and no branch was created.
- Workflow 93 (Case Status Portal) and workflow `02 - SBO.02 - Profiling Super Agent` (called by 92) are not in the upload; see docs/07 G-01, G-05.
- The review, status and evidence endpoints are unauthenticated **because the source forms are**: run this only on a trusted demo network. See `docs/security-review.md` (independent review; 14 findings, all triaged) and `docs/post-parity-enhancements.md`.
- Hardening deviations from the source (each pinned by a test and listed in docs/07): a reviewed or superseded case cannot be re-evaluated from the chat (`CASE_LOCKED`); PDFs are parsed in a bounded worker (≤ 50 pages, 8 s); evidence resolution / resubmission run as one locked transaction.
