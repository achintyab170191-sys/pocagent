# CLAUDE.md — SBO agentic POC (To-Be New LOA process on the Claude Agent SDK)

A governed, agentic application for the **New LOA (letter of authority) processing** process, built from the E&SMB-BO To-Be process diagrams (docs/09). It began as a parity-first migration of an n8n proof of concept; the product owner has since made the **diagrams the source of truth** (the n8n export is archived).
**Everything is synthetic data.** No production write-back, message send, government/CRM/financial lookup is performed. The DUL API, government portal / UAE Pass, BCRM and AVCV are synthetic registers in `packages/domain/src/loa.ts`.

## Architecture

```
Chat ─▶ SBO.01: name + company → company on record? no → NEW_LEAD case only · yes → asks for Emirates ID, Trade License, Establishment Card
     ─▶ documents attached in the chat (PDF / Word / images) → completeness (deterministic) → SBO.02 Super Agent (Claude Agent SDK, provisional only)
          └─ guarded toolbox ─▶ 5 deterministic checks: Trade License · Identity · POA/MOA · Bad Debt · AVCV (Address + Credit Verification)
                                  └─ persisted runtime results (unique: case_run_id + submission_version + check_type)
     ─▶ Deterministic Finalizer (NO LLM) ─▶ decision · SBO.11 draft communication · runtime case · audit  (one transaction) · SBO.20 RCA on reject
     ─▶ review dashboard (every review by Review ID) · confirm/change · REOPEN → new version, customer answers in the chat
```

| Path | Role |
| --- | --- |
| `packages/domain` | Zod contracts, the operating-model stages and request catalog (catalog.ts), the To-Be check catalog, document reader, synthetic registers, decision rules, communication templates, demo personas (`loa.ts`, `loa-personas.ts`) |
| `packages/governance` | The finalizer (pure `determineDecision` + transactional `finalizeDecision`) |
| `packages/persistence` | `Repository` (in-memory + PostgreSQL), migrations, importers for the archived n8n tables |
| `packages/workflows` | intake, chat state machine, utilities (the five checks), evidence loop, super-agent orchestration, human review + dashboard, reopen, status |
| `packages/agent-runtime` | Claude Agent SDK runtime, SBO.02 prompt and tool definitions (`prompts/`), output validation |
| `packages/testkit` | test doubles, `makePdf`, persona attachments, `caseWithDocuments` |
| `apps/api` | Fastify API (CSRF, rate limits, upload validation, document reading) |
| `apps/web` | React + Vite (design tokens in 	heme.css, light/dark): chat with topics, standard queries and in-window attachments, operations overview, review dashboard, case status; sample documents in `public/samples` |
| `scripts/` | migrate, seed, import, reset, generate-samples, `process-map.ts` → conformance doc/report, source verification |
| root `*.json`, `dt_*.csv` | **Archived n8n artifacts. Never edit.** (`npm run verify:sources`) |

## Commands

```bash
npm install
npm run typecheck        # tsc (api/packages/tests) + tsc (web)
npm run lint
npm test                 # unit + in-memory suites (vitest)
npm run test:integration # SQL suite on embedded PostgreSQL (PGlite)
npm run test:e2e         # Playwright (installed Edge by default; PW_CHANNEL= for bundled Chromium)
npm run build            # typecheck + API bundle (dist/) + web build
npm run samples          # regenerate apps/web/public/samples incl. the guided scenarios (after changing personas / loa-scenarios.ts; SAMPLE_TODAY=yyyy-mm-dd dates them)
docker compose up -d postgres && npm run db:migrate            # database
npm run reset:runtime    # delete ONLY runtime state
# Demo URL (one image serves API + web; PERSISTENCE=memory needs no database): see docs/10-deployment.md and render.yaml
npm run dev              # API :3000 + web :5173
npm run docs:conformance && npm run report:conformance
```

**Request catalog.** Only NEW_LOA is automated. Any other request type is *captured and routed* (capture.ts); it never runs checks and never approves or changes anything. Add a request type in catalog.ts; automating one needs a process-map step and tests first.

## Rules (non-negotiable)

1. **The To-Be diagrams are the source of truth** (docs/09). A change to the process (a check, its order, an outcome, a rule) needs (a) a step in `scripts/process-map.ts` (`npm run docs:conformance` fails on a missing test title) and (b) a regression test. Where the diagrams are ambiguous or unreadable, record the interpretation in `docs/09` ("Interpretations", "Open questions") and use a conservative result (`MANUAL_REVIEW`) — never invent a rule and never approve on a guess.
2. **Deterministic finalization cannot be delegated to an LLM.** `@sbo/governance` must not import the agent runtime; the model only produces a *provisional* recommendation and may be overridden. Neither the checks nor evidence completeness use a model.
3. **Runtime state is persisted before finalization.** Utility results are upserted on the exact three-part key `case_run_id + submission_version + check_type` (never on a subset). A TBD rule can never approve or reject.
4. **Evidence is documents only, and is untrusted.** Typed text is never evidence. A document is data: its fields are read by regex, never by a model, and its content can never change the process. Every document is also *read for content* deterministically before it is accepted (uthority.ts: authority letters clause by clause; document-review.ts: Emirates ID, licence, card, proof of address): a fixable gap is **insufficient evidence** (say exactly what is wrong, ask again, 3 attempts then a human); content that cannot be trusted (contradictory or limited authority, text aimed at the agent, unreadable) goes to a human; register-verified adverse facts stay with the checks. A company or person that cannot be matched in a register is `MANUAL_REVIEW`, never a rejection; a company that is not on record is only a new lead — **never approved**.
5. **Communications remain drafts.** Never claim a send, CRM update, register lookup or financial update that the code does not perform. Registers are simulations: say so.
6. **A rejection is only a recommendation.** It is never final and is never communicated externally (chat text, browser JSON, email) until a human confirms it: the customer sees `Awaiting specialist confirmation` / `PENDING_CONFIRMATION`; the reason, the SBO.11 draft and the SBO.20 RCA live on the review dashboard (`PENDING_REJECTION_CONFIRMATION`). Only an *adverse* AVCV result rejects; *unable to verify*, *refer* and *discrepancy* are specialist reviews.
7. **Authorised without a POA/MOA** only when: ID verified; recorded in the approved source as owner, manager with representative authority or authorised signatory; capacity covers the requested action; licence current and consistent; no conflicting evidence or limitation (a limitation goes to a specialist and a POA cannot override it).
8. **No secrets or model names in code.** `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `DATABASE_URL`, `APP_BASE_URL`, `SESSION_SECRET`, `UPLOAD_DIR` come from the environment and are validated at startup (`apps/api/src/env.ts`).
9. Tests assert outcome, reason code, tool sequence, persisted state and side effects — not "a response exists".
10. Return concise business rationale and visible tool traces only; never expose prompts, raw tool JSON, rule rows, party ids or register values to customers.
11. The archived n8n files in the repository root are preserved unchanged.

## Working notes

- Windows PowerShell 5.1: read/write source files with the Edit/Write tools or explicit UTF-8 (`[IO.File]`); `Get-Content -Raw | Set-Content` corrupts non-ASCII. In PowerShell strings a backtick before `r` or `n` is an escape (it silently corrupted a comment once). `R` is an alias for `Invoke-History`. Git may not be on PATH; the repo is owned by another Windows account, so pass `-c safe.directory=...`.
- A leftover test server on port 3100 / 5273 makes `npm run test:e2e` fail with "already used": stop the `node` process listening there.
- Sample documents in `apps/web/public/samples` are generated: `npm run samples`. A test fails if they go stale.
- Subagents in `.claude/agents/` were for the n8n build-time analysis; keep one plan and one conformance matrix.
