# SBO agentic POC — New LOA processing (To-Be process) on the Claude Agent SDK

A governed, agentic implementation of the **New LOA (letter of authority) processing** process from the E&SMB-BO To-Be diagrams: a customer chats with a bot, says who they are and which company they represent, attaches their documents in the same window, and a Super Agent (SBO.02) runs the specialist checks. A **deterministic finalizer** — never the model — issues the governed outcome (`APPROVE`, `REJECT`, `NEED_MORE_INFORMATION`, `MANUAL_REVIEW`). Human review, a review dashboard, a reopen workflow, draft communications and a full audit trail are included.

> **All data is synthetic.** The DUL API, government portal / UAE Pass, BCRM and AVCV are synthetic registers, not integrations. No production system is read or written and no message is sent. Communications are drafts.

The process is taken from photographs of the To-Be diagrams (pages 12–13); how they were read, what was built and what was not is in [docs/09](docs/09-to-be-process-alignment.md). The earlier n8n proof of concept (`NN - *.json`, `dt_*.csv`) is **archived** unchanged in the repository root (`npm run verify:sources`).

## The process

```
Customer chat ─▶ SBO.01 orchestrator: name + company → company on record?
                    no  → NEW LEAD case only (nothing checked, nothing approved)
                    yes → case opened, chat asks for Emirates ID, Trade License, Establishment Card (attach in the same window)
              ─▶ SBO.02 Super Agent (Claude Agent SDK — provisional recommendation only) calls, in order, and stops at a terminal result:
                    1 Trade License Check (SBO.06)   TL/EC validity, names; DUL API → QR → government portal (UAE Pass)
                    2 Identity Validation (SBO.07)   Emirates ID vs licence records and the request
                    3 POA/MOA Check                  only when the person is not recorded as owner / manager with authority / signatory covering the request (asks in the chat)
                    4 Bad Debt Check (SBO.09/08)     bad debt and blue-collar behaviour on every linked party
                    5 AVCV (SBO.10)  Address Verification and Credit Verification: only an ADVERSE result rejects
              ─▶ Deterministic finalizer (no LLM): decision · SBO.11 draft email · runtime case · audit  (one transaction)
                    APPROVE → done · REJECT recommended → SBO.20 root-cause analysis; NOT final and NOT shown to the customer until a human confirms it on the review dashboard
              ─▶ Review dashboard: every review by Review ID; confirm / change, or REOPEN → a new version; the customer answers in the chat
```

Evidence is **documents only** (PDF, Word, images); typed text is never accepted as evidence.

Monorepo: `apps/api` (Fastify) · `apps/web` (React + Vite) · `packages/{domain,governance,persistence,workflows,agent-runtime,testkit}` · `scripts/` · `docs/`. No ORM: the `postgres` driver with hand-written SQL behind a `Repository` interface, so the in-memory test double and PostgreSQL behave identically.

## Set up and run

Prerequisites: Node.js 20+ (developed on 24), npm; Docker only if you want a PostgreSQL server.

```bash
npm install
cp .env.example .env        # then edit: ANTHROPIC_API_KEY, CLAUDE_MODEL, SESSION_SECRET (>= 32 chars)
docker compose up -d postgres
npm run db:migrate
npm run dev                 # API http://localhost:3000, web http://localhost:5173
```

No model key? Set `AGENT_RUNTIME=deterministic` in `.env`: the five checks and the finalizer run without a model. **Evidence completeness and every check are deterministic in both modes**; the model only adds the provisional recommendation.

| Command | What it does |
| --- | --- |
| `npm run typecheck` / `lint` | TypeScript strict (API/packages/tests + web) / ESLint |
| `npm test` | Unit + in-memory suites (vitest) |
| `npm run test:integration` | SQL suite on embedded PostgreSQL (PGlite) — migrations, constraints, repositories, transactions, the whole process on SQL |
| `npm run test:e2e` | Playwright browser suite (installed Edge; `PW_CHANNEL= npx playwright test` for bundled Chromium) |
| `npm run build` | Typecheck + API bundle + web build |
| `npm run samples` | Regenerate the synthetic sample documents in `apps/web/public/samples/` |
| `npm run docs:conformance` | Rebuild `docs/05` (fails on any step whose referenced test does not exist) |
| `npm run report:conformance` | Run all suites, replay every demo persona, write `docs/conformance-report.md` + `artifacts/conformance-report.json` |
| `npm run reset:runtime` | Delete **only** runtime state |
| `npm run verify:sources` | SHA-256 check of the archived n8n files |

## Deploy a demo URL

One Docker image serves the API and the web app on a single address, with a shared password and no database (`PERSISTENCE=memory`). Step-by-step for Render and other Docker hosts: [docs/10-deployment.md](docs/10-deployment.md); Render Blueprint: [render.yaml](render.yaml).

## What the assistant offers

The chat opens with **eight topics** (authorised representative & company profile · correct or verify data · mobile and SIM · new services · change a service · move, transfer or port · renew or cease · verification, compliance and legal) and **ready-made questions** you can click, or you can type a request in your own words. Every request type of the operating model (profiling → verifier task → processing) is in the catalog. **Only New LOA is automated**; any other request is *captured and routed* to the team that owns it (VERIFIER_OPERATIONS, PROCESSING_ORDERS, ...) with a plain statement that nothing was checked, approved or changed. The **Operations** page shows the six stages of the operating model and the captured requests.

## Demo (web app, open http://localhost:5173)

Open **Assessment chat** and expand *Demo: synthetic customers and sample documents*. Click a customer to fill the introduction, send it, then attach that customer's sample documents (each row has download links).

| Customer | What you see |
| --- | --- |
| **Fatima Al Mansoori — Al Noor Trading LLC** | Owner, valid documents: five checks pass in order → *Eligible to proceed*, draft approval email. |
| **Noura Al Falasi — Marina Bay Catering LLC** | The DUL API is down; the licence is verified through the government portal (UAE Pass) → passes *with a flag*. |
| **Mariam Saeed — Dune Ridge Engineering LLC** | The licence number is unreadable; the QR code is used. |
| **Omar Haddad — Gulf Horizon Contracting LLC** | Not the owner: the chat asks for a Power of Attorney **in the same window**; attach `power-of-attorney.pdf`; the assessment resumes and approves. |
| **Sara Khan — Desert Bloom Cafe LLC** | Trade License expired → the agent recommends rejection, but the customer only sees *Awaiting specialist confirmation*; the reason, a draft email and a root-cause analysis are on the dashboard for a human to confirm. |
| Rashid Al Ketbi · Layla Nasser · Tariq Mahmood · Yousef Ibrahim · Hessa Al Ameri | ID name mismatch · bad debt on a duplicate party · blue-collar behaviour · adverse credit verification · expired POA — rejection recommended at the right check, pending human confirmation. |
| **Layth Barakat — Al Noor Trading LLC** | Recorded as a manager with full authority: no POA needed. |
| **Ahmed Yusuf — Gulf Horizon Contracting LLC** | Recorded manager whose capacity covers only some actions: a POA is required, then approval. |
| **Jamal Farouk — Falcon Logistics LLC** | A recorded limitation on his authority: a specialist decides; a POA cannot override it. |
| **Ibrahim Karam · Reem Al Hosani — Cedar Point / Palm Grove** | AVCV discrepancy · AVCV unable to verify: specialist review, not a rejection. |
| **Adel Mansour — Coral Reef Diving LLC** | AVCV has insufficient information: the chat asks for **proof of address** in the same window, then approves. |
| Anyone at a company not on the list | **New lead** case: nothing checked, nothing approved. |

Then open **Review dashboard**: every review is listed by Review ID. Open a recommended rejection, see the reason, the checks, the documents received and the root-cause analysis, confirm it — or **reopen** it with a note: a new version (`AUTH-101-V2`) is created and the customer's chat asks for the documents again. There is no separate resubmission or upload page.

## What is where

| Need | Read |
| --- | --- |
| **How the diagrams were read, the operating model and request catalog, what was built and not, open questions** | `docs/09-to-be-process-alignment.md` |
| **Diagram step → code → test matrix** (generated & validated) | `docs/05-to-be-process-conformance.md` |
| Test results and conformance % | `docs/conformance-report.md`, `artifacts/conformance-report.json` |
| Case / evidence / review state machines | `docs/06-state-machine-specification.md` |
| Security findings | `docs/security-review.md` |
| The archived n8n analysis (inventory, graph, nodes, data dictionary, gaps) | `docs/01`–`04`, `docs/07`, `docs/08` — reference only, superseded by docs/09 |
| Rules for contributors / agents | `CLAUDE.md`, `.claude/agents/` |

## API

| Purpose | Route |
| --- | --- |
| Chat: introduction, replies | `POST /api/chat` · `GET /api/chat/state` (what the conversation is waiting for) |
| Attach documents in the chat (up to 3 files) | `POST /api/chat/evidence` |
| One document for an explicit request; validate / resolve / cancel | `POST /api/evidence/:id/upload` · `GET /api/evidence/:id` · `POST /api/evidence/:id/resolve` · `POST /api/evidence/:id/cancel` |
| Case status | `GET /api/cases/:caseRunId/status` · `GET /api/cases` |
| Review dashboard, detail, completion | `GET /api/reviews` · `GET /api/reviews/:reviewId` · `POST /api/reviews/:reviewId/complete` |
| Reopen a case | `POST /api/cases/:caseRunId/reopen` |
| Demo customers and sample documents | `GET /api/scenarios` |
| Operating model, request catalog, standard queries | `GET /api/catalog` · `POST /api/chat` accepts an optional `intent` |
| Operations overview (stages, captured requests) | `GET /api/operations` |
| Session / CSRF / health | `GET /api/session` · `GET /health` |

State-changing routes require the double-submit CSRF header and an Origin check; POSTs are rate-limited (uploads ≤ 10/min/client); attachments are identified by magic bytes (PDF, Word .docx, PNG/JPEG/GIF/BMP/WebP; 5 MB each; legacy .doc refused; images read offline with OCR), stored outside any web root under generated names.

## Honest limits

- **No live Claude call has been made** in this build. The SDK integration is tested against an injected SDK double; the checks, the evidence loop and the finalizer do not depend on model behaviour.
- **The registers are synthetic.** A real DUL API / government portal / BCRM / AVCV integration does not exist here; "SIMULATED" steps in docs/05 prove the process logic only.
- **Only the New LOA chatbot process is automated.** Every other request type in the catalog is captured and routed, not processed; the verifier task, processing, control tower, governance and reporting are not built (docs/09).
- **The diagrams were read from photographs** of a screen; docs/09 lists the interpretation to confirm.
- **OCR is offline and imperfect**: a blurry photo may be refused as unreadable. PDF and Word are reliable.
- **No PostgreSQL server or Docker** was available: SQL is tested on embedded PostgreSQL (PGlite) via the same driver.
- The review, status and evidence endpoints are unauthenticated: run this only on a trusted demo network (`docs/security-review.md`).
