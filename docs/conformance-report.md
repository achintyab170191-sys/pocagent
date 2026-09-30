# Conformance report

Generated 2026-09-30T09:06:01.249Z on Node v24.21.0 by `npm run report:conformance`. Machine-readable copy: `artifacts/conformance-report.json`.
The behaviour under test is the **To-Be New LOA process** (docs/09), not the earlier n8n export.

## Result

| Measure | Value |
| --- | ---: |
| Process steps mapped (docs/05) | 43 |
| Steps **verified** (implemented + every referenced test passed) | 40 |
| Steps out of scope (in the diagrams, not built) | 3 |
| Steps unverified | 0 |
| **Conformance of in-scope steps** | **100%** (40/40) |

"Verified" means a mapped implementation exists and every test title referenced in `docs/05` matched at least one passing test in this run. Steps marked SIMULATED run against a synthetic stand-in for an external system; they prove the process logic, not a real integration.

## Test suites

| Suite | Command | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: |
| unit | `npx vitest run` | 374 | 0 | 0 |
| integration | `npx vitest run --config vitest.integration.config.ts` | 19 | 0 | 0 |
| e2e | `npx playwright test` | 33 | 0 | 0 |

## Demo personas (replayed through the chat with their sample documents)

| Customer | Story expectation | Governed outcome | Reason | Tools called | Matches |
| --- | --- | --- | --- | ---: | --- |
| Fatima Al Mansoori / Al Noor Trading LLC | APPROVE | APPROVE | ALL_CHECKS_PASSED | 5 | yes |
| Noura Al Falasi / Marina Bay Catering LLC | APPROVE | APPROVE | ALL_CHECKS_PASSED | 5 | yes |
| Mariam Saeed / Dune Ridge Engineering LLC | APPROVE | APPROVE | ALL_CHECKS_PASSED | 5 | yes |
| Omar Haddad / Gulf Horizon Contracting LLC | NEED_MORE_INFORMATION_THEN_APPROVE | APPROVE | ALL_CHECKS_PASSED | 3 | yes |
| Hessa Al Ameri / Al Noor Trading LLC | REJECT | REJECT | POA_MOA_NOT_CLEARED | 1 | yes |
| Sara Khan / Desert Bloom Cafe LLC | REJECT | REJECT | TRADE_LICENSE_EXPIRED | 1 | yes |
| Rashid Al Ketbi / Falcon Logistics LLC | REJECT | REJECT | IDENTITY_MISMATCH | 2 | yes |
| Layla Nasser / Pearl Coast Real Estate LLC | REJECT | REJECT | BAD_DEBT_OBSERVED | 4 | yes |
| Tariq Mahmood / Sahara Staffing Services LLC | REJECT | REJECT | BLUE_COLLAR_OBSERVED | 4 | yes |
| Yousef Ibrahim / Oasis Tech Solutions FZ-LLC | REJECT | REJECT | AVCV_ADVERSE | 5 | yes |
| Layth Barakat / Al Noor Trading LLC | APPROVE | APPROVE | ALL_CHECKS_PASSED | 5 | yes |
| Ahmed Yusuf / Gulf Horizon Contracting LLC | NEED_MORE_INFORMATION_THEN_APPROVE | APPROVE | ALL_CHECKS_PASSED | 3 | yes |
| Jamal Farouk / Falcon Logistics LLC | MANUAL_REVIEW | MANUAL_REVIEW | AUTHORITY_LIMITED | 3 | yes |
| Ibrahim Karam / Cedar Point Consulting LLC | MANUAL_REVIEW | MANUAL_REVIEW | AVCV_DISCREPANCY | 5 | yes |
| Reem Al Hosani / Palm Grove Hospitality LLC | MANUAL_REVIEW | MANUAL_REVIEW | AVCV_UNVERIFIED | 5 | yes |
| Adel Mansour / Coral Reef Diving LLC | NEED_MORE_INFORMATION_THEN_APPROVE | APPROVE | ALL_CHECKS_PASSED | 1 | yes |
| Hana Rangi / Kauri Harbour Demo Digital Limited | NEED_MORE_INFORMATION | NEED_MORE_INFORMATION | POA_MOA_MISSING | 3 | yes |
| Liam Chen / Bluegum Vector Demo Pty Ltd | REJECT | REJECT | POA_MOA_NOT_CLEARED | 1 | yes |
| Maia Thompson / Tui Peak Demo Services Limited | REJECT | REJECT | TRADE_LICENSE_INACTIVE | 1 | yes |
| Noah Patel / Coral Grid Demo Solutions Pty Ltd | MANUAL_REVIEW | MANUAL_REVIEW | DUPLICATE_RECORD_CONFLICT | 2 | yes |
| Aroha Kingi / Fernline Demo Mobility Limited | REJECT | REJECT | AVCV_ADVERSE | 3 | yes |
| Chloe Nguyen / Southern Arc Demo Facilities Pty Ltd | MANUAL_REVIEW | MANUAL_REVIEW | LICENSE_NOT_VERIFIABLE | 1 | yes |
| Marcus Lee / Harbour Quartz Demo Consulting Pty Ltd | NEED_MORE_INFORMATION_THEN_APPROVE | APPROVE | ALL_CHECKS_PASSED | 3 | yes |
| Sophie Williams / Aoraki Lantern Demo Limited | MANUAL_REVIEW | MANUAL_REVIEW | DOCUMENT_SECURITY_REVIEW | 1 | yes |
| Jack Morgan / Red Earth Demo Logistics Pty Ltd | MANUAL_REVIEW | MANUAL_REVIEW | AVCV_UNVERIFIED | 3 | yes |
| Emma Wilson / Wattle Ridge Demo Networks Pty Ltd | NEED_MORE_INFORMATION_THEN_APPROVE | APPROVE | ALL_CHECKS_PASSED | 3 | yes |

## Out of scope

- **X1** Other To-Be processes: Mobile Re-Registration, Document Update, Combo (Document Update + LOA / LOA + Re-Registration), Regularization, PMP, TASK/TKT, Data Quality Assurance — Only the New LOA chatbot-triggered process was built. The other diagrams reuse SBO.05 (document extraction), SBO.12 (system data check / reconciliation) and other utility agents that are not implemented.
- **X3** Automation of the verifier task (MNP, activations, transfer of ownership, SIM replacement, AVCV field work, legal letters, biometric verification), processing (order creation, quality checks, contract validation, delivery, lifecycle tracking), the control tower, governance and reporting — Requests for these are captured and routed (T9); nothing runs on them.
- **X2** Ticket-triggered and channel-partner-triggered variants of New LOA; SBO.05 document extraction agent; SBO.13 order execution; SBO.14 case lifecycle tracking — The chat variant is the only entry point. The ticket variants share the same five checks and could be added on top.

## Unverified steps

None — every in-scope step maps to passing tests.

## What this report does not prove

- No live Claude call was made; the agent runtime is exercised against an SDK test double.
- The DUL API, government portal / UAE Pass, BCRM and AVCV are synthetic registers, not integrations.
- SQL ran on embedded PostgreSQL (PGlite), not a Docker PostgreSQL server; browser tests ran on Microsoft Edge.
- The diagrams were read from photographs of a screen; docs/09 lists the interpretation and the open questions.
