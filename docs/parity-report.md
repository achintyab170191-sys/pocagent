# Parity report

Generated 2026-09-29T17:42:47.593Z on Node v24.21.0 by `npm run report:parity`. Machine-readable copy: `artifacts/parity-report.json`.

## Result

| Measure | Value |
| --- | ---: |
| Workflows ported | 13 of 13 uploaded (expected Workflow 93 is absent from the upload; status view is an adapter — doc 07 G-01) |
| n8n nodes | 229 |
| Nodes **verified** (implemented + every referenced test passed) | 226 |
| Nodes explicitly UNSUPPORTED (n8n editor scaffolding) | 3 |
| Nodes unverified | 0 |
| **Parity of in-scope nodes** | **100%** (226/226) |
| Parity of all nodes | 98.7% (226/229) |

Traceability status of the 229 nodes: REPLACED_BY_PLATFORM 23 · PARITY_TESTED 152 · PARITY_TESTED_DEVIATION 44 · SOURCE_DEFECT_NOT_REPRODUCED 7 · UNSUPPORTED 3.
"Verified" means a mapped implementation exists and every test title referenced in `docs/05` matched at least one passing test in this run — it does not mean n8n's runtime is identical in every edge case (see docs/07 for the deviations).

## Test suites

| Suite | Command | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: |
| unit | `npx vitest run` | 231 | 0 | 0 |
| integration | `npx vitest run --config vitest.integration.config.ts` | 18 | 0 | 0 |
| e2e | `npx playwright test` | 21 | 0 | 0 |

## AUTH regression (replayed from the preserved fixtures)

| Case | Brief expectation | Governed outcome | Reason | Rule | Tools called | Evidence request | Matches brief |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AUTH-001 | clean path → APPROVE / ALL_CHECKS_PASSED | APPROVE | ALL_CHECKS_PASSED | FINAL-001 | 7 | — | yes |
| AUTH-002 | missing authority document → NEED_MORE_INFORMATION | NEED_MORE_INFORMATION | AUTHORITY_MISSING | AUTH-002 | 1 | FILE_UPLOAD | yes |
| AUTH-003 | authority ambiguity → evidence request; accepted evidence resumes remaining checks | MANUAL_REVIEW | AUTHORITY_SCOPE_AMBIGUOUS | AUTH-004 | 4 | CHAT_OR_FILE | first leg yes; see below |
| AUTH-004 | inactive business → REJECT / BUSINESS_INACTIVE | REJECT | BUSINESS_INACTIVE | REG-003 | 2 | — | yes |
| AUTH-005 | duplicate/conflicting CRM → MANUAL_REVIEW / DUPLICATE_RECORD_CONFLICT | MANUAL_REVIEW | DUPLICATE_RECORD_CONFLICT | CRM-002 | 5 | — | yes |
| AUTH-006 | final verification failure → REJECT / FINAL_VERIFICATION_FAILED | REJECT | FINAL_VERIFICATION_FAILED | CMP-002 | 7 | — | yes |
| AUTH-007 | registry unavailable → MANUAL_REVIEW / REGISTRY_UNAVAILABLE | MANUAL_REVIEW | REGISTRY_UNAVAILABLE | REG-002 | 2 | — | yes |
| AUTH-008-V1 | insufficient authority → NEED_MORE_INFORMATION | NEED_MORE_INFORMATION | AUTHORITY_SCOPE_INSUFFICIENT | AUTH-005 | 4 | CHAT_OR_FILE | yes |
| AUTH-008-V2 | corrected resubmission → APPROVE | APPROVE | ALL_CHECKS_PASSED | FINAL-001 | 7 | — | yes |
| AUTH-009 | prompt injection → MANUAL_REVIEW / PROMPT_INJECTION_DETECTED | MANUAL_REVIEW | PROMPT_INJECTION_DETECTED | SEC-001 | 1 | — | yes |
| AUTH-010 | policy TBD → MANUAL_REVIEW / TBD_POLICY | MANUAL_REVIEW | TBD_POLICY | CTRL-001 | 6 | — | yes |

**AUTH-003 (reported mismatch, not altered).** The first leg matches (MANUAL_REVIEW / AUTHORITY_SCOPE_AMBIGUOUS, evidence request on the authority gap). The brief expects accepted evidence to resume the remaining checks and, implicitly, reach approval. The source fixture rows for AUTH-003's system-data, financial and final-verification checks are `NOT_RUN`, so after EVID-001 the source lands in `MANUAL_REVIEW / MANDATORY_CHECKS_INCOMPLETE` — corroborated by the historical export (5 runtime rows; case ended REVIEW_PENDING / MANDATORY_CHE…). The resume mechanism itself (continue from the next incomplete check without restarting passed checks, ending in APPROVE) is proven on a labelled focused fixture. Details: docs/07 G-12.

## Unsupported nodes

- 90 - Finalize Decision.json › **When clicking ‘Execute workflow’** — Debug scaffolding for running Workflow 90 from the n8n editor; equivalent is the finalizeDecision unit/integration tests.
- 90 - Finalize Decision.json › **Edit Fields** — Debug scaffolding for running Workflow 90 from the n8n editor; equivalent is the finalizeDecision unit/integration tests.
- 90 - Finalize Decision.json › **Call '90 - Finalize Decision'** — Debug scaffolding for running Workflow 90 from the n8n editor; equivalent is the finalizeDecision unit/integration tests.

## Unverified nodes

None — every in-scope node maps to passing tests.

## What this report does not prove

- No live Claude call was made; the agent runtime is exercised against an SDK test double (docs/08).
- SQL ran on embedded PostgreSQL (PGlite), not a Docker PostgreSQL server; browser tests ran on Microsoft Edge.
- Behaviour where the source is a defect or the brief conflicts with the source is listed in docs/07, not hidden in the percentage.
