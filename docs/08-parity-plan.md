# Parity plan and status

The migration is parity-first: behaviour was ported and pinned by tests **before** anything was improved, and improvements live only in `docs/post-parity-enhancements.md`.

## Method

1. **Discover** — `npm run analyse:sources` inventories every file, node, table, connection and table read/write (docs 01–04, `artifacts/source-node-catalog.json`, `artifacts/source-checksums.json`). `npm run verify:sources` proves the uploads are unchanged.
2. **Read the code nodes, not the summaries** — every Workflow 03/90/91/92/95/96 code node and the utility template were read line by line and compared with the port. That comparison found the defects and conflicts in doc 07 (e.g. the ILIKE substring match behind AUTH-009, the misspelled switch key, the missing chat-entry reset, wrong audit event names and ID formats in the first port).
3. **Map every node** — `scripts/traceability-map.ts` → `npm run docs:traceability` → doc 05 + `artifacts/traceability.json`. The generator fails on an unmapped node or a test reference that does not exist.
4. **Port deterministic logic first** (utilities → persistence contract → Workflow 90), then the agent (Workflow 03 on the Claude Agent SDK), then evidence (95/96), review/resubmission/status (91/92/93-adapter), then UI.
5. **Prove** — unit/in-memory (`npm test`), real SQL on embedded PostgreSQL (`npm run test:integration`), browser (`npm run test:e2e`), then `npm run report:parity` for the machine-readable report.

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Repository + source validation, checksum manifest | Done. Git is not installed on the authoring machine, so no commit/branch was made (see README). |
| 1 | Reverse engineering: docs 01–04, gaps, state machine | Done |
| 2 | Domain, database, importers, seeds, reset, schema tests | Done (`sql.integration.test.ts`) |
| 3 | Utilities 05/06/07A/07B/09/10/12 | Done |
| 4 | Workflow 90 deterministic Finalizer | Done |
| 5 | Workflow 03 Super Agent on the Claude Agent SDK | Done; live-model behaviour **not exercised** (no API key) — see limits |
| 6 | Workflows 95/96 evidence | Done |
| 7 | Workflows 91/92 + status adapter (93 absent) | Done |
| 8 | UI + synthetic disclaimers | Done |
| 9 | Full regression, security review, parity report | Done — `docs/parity-report.md`, `docs/security-review.md` |

## Limits of what was verified

- **No live Claude call was made.** The SDK wiring (tool registration, least-privilege options, system prompt, structuring and evidence calls) is tested against an injected SDK double; model behaviour is not. The safety of the design does not depend on the model: tools are guarded, output is schema-validated, and the Finalizer is deterministic.
- **No Docker/PostgreSQL server was available.** SQL is exercised on embedded PostgreSQL 18 (PGlite) through the same `postgres` driver. `docker-compose.yml` is provided but was not started here.
- **Playwright ran on the installed Microsoft Edge** (`channel: msedge`), not Playwright's bundled Chromium.
- Parity percentages count nodes with a mapped implementation **and** a passing referenced test; they are not a claim that n8n runtime semantics are identical in every edge case (see doc 07).
