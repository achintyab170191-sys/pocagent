# 09 — Aligning the application to the To-Be process diagrams

**Decision (product owner):** the E&SMB-BO To-Be process diagrams replace the earlier n8n export as the source of truth. The n8n analysis (docs 01–04, 07, 08) is archived as reference; `NN - *.json` and `dt_*.csv` are preserved unchanged.

## What was read

Eighteen photographs of a PDF viewer ("E& SMB-BO To-Be Process.pdf", 206 pages), pages 12–29:

| Page | Content |
| --- | --- |
| 12 | Overview of the agents and their hierarchy: SBO.01 back-office orchestrator, SBO.02 profiling super agent, and the utility agents (SBO.05 document extraction, SBO.06 trade licence, SBO.07 identity, SBO.09 bad debt, SBO.10 AVCV, SBO.11 communication, SBO.12 system data check, SBO.13 order execution, SBO.14 case lifecycle tracking, SBO.20 RCA). |
| **13** | **New LOA Processing — triggered by the customer through the conversational chatbot** (the process built here). |
| 14–15 | The ticket-triggered and channel-partner-triggered variants of New LOA. |
| 16–18 | Mobile Re-Registration (chatbot / ticket / channel-partner). |
| 19–21 | Data Quality Assurance; Document Update. |
| 22–27 | Combo processes (Document Update + LOA, LOA + Re-Registration). |
| 28–29 | Regularization; PMP. |

Pages 13 and 12 were read most closely. **The photographs are angled and small; the reading below is an interpretation to be confirmed** (see "Open questions").

## The process built (page 13)

| Diagram step | Built as |
| --- | --- |
| Customer places a request with the chatbot; the chatbot asks for the required information; customer provides details | Chat intake: name + company, asked for only if missing. |
| Chatbot connects to a human agent, who creates the ticket in BCRM | A company **not on record** becomes a new-lead case (no checks, nothing approved). |
| SBO.01 converts the request to a ticket, validates it, routes it to SBO.02; documents not uploaded → SBO.11 drafts an email for pending information | Case created; the chat asks for Emirates ID, Trade License and Establishment Card and stays open until all are attached (3 attempts, then a human). |
| SBO.02 → SBO.06: TL and EC validity; TL not readable → QR; DUL API; DUL failure → government portal via UAE Pass; EC and TL name vs EID name | **Trade License Check**. |
| TL expired / name mismatch → reject, SBO.11 email, SBO.20 RCA | Rules TL-002/003/004 → REJECT; draft email; deterministic RCA summary; human confirms. |
| SBO.02 → SBO.07: cross-check EID / EC with the TL name; mismatch | **Identity Validation** (register name vs printed name vs request name; expired ID asks for a new one). |
| POA/MOA workflow: document available? checks cleared / not cleared | **POA/MOA Check**, only when the person is not the licence owner or an authorised signatory; missing → asks in the chat; expired / wrong grantee / wrong scope → REJECT. |
| SBO.09 bad debt and blue-collar checks; SBO.08 duplicate PDs in BCRM | **Bad Debt Check** over every party linked to the licence or person. |
| SBO.10 AVCV; successful → approve + SBO.11; not successful → reject | **AVCV Verification**; APPROVE only if all five passed. |

## Product-owner requests implemented on top

1. Evidence is documents only — typed text is refused (`Typed text can't be used as evidence`).
2. Documents (PDF, Word, images) are attached in the chat window, including the second request (POA) and re-uploads.
3. A **review dashboard** listing every review by Review ID, with checks, documents received and the RCA.
4. A **reopen** workflow from the dashboard replaces the resubmission page: a new version of the case (`AUTH-101` → `AUTH-101-V2`), the old one closed, and the customer's chat asks for documents again.
5. A company that is not on record is only a new lead.

## What was kept from the migration

The Claude Agent SDK runtime (provisional recommendation only), the guarded five-tool toolbox (order, no repeats, stop at a terminal result), the deterministic finalizer with no model dependency, the three-part persistence key `case_run_id + submission_version + check_type`, the transactional decision + communication + runtime case + audit write, CSRF/Origin/rate-limit/upload hardening, the case-locking rule, and the PostgreSQL + in-memory `Repository`.

## What changed in the engine

| Area | Before (n8n) | Now (To-Be) |
| --- | --- | --- |
| Checks | 7 fixture-driven checks | 5 computed checks over the uploaded documents and synthetic registers (`packages/domain/src/loa.ts`) |
| Rules and templates | CSV data tables | Code (`loaDecisionRules`, `loaCommunicationTemplates`); no TBD rules |
| Evidence | text or PDF, judged by an LLM | documents only; completeness decided by deterministic code; readers are regex-based, never a model |
| Evidence gaps | authority / identity questions | which **documents** are still needed |
| Post-decision | versioned resubmission page | reopen from the review dashboard |
| Traceability | 229 n8n nodes | 36 diagram steps (`docs/05`) |

## Operating model and request catalog (product-owner definitions)

| Stage | What it is |
| --- | --- |
| 1 **Profiling** | Establishes who the customer and company are and who may act for them. Requests: New LOA processing, mobile re-registration, data quality assurance, document update, regularization, POA/MOA/AOA approval, MOL approval, TRN, address verification. |
| 2 **Verifier task** | Activities that need operational or physical verification, specialist coordination or manual completion (B2B telco): mobile number portability, new activation (prepaid, reprovision), transfer of ownership, SIM replacement, mobile registration, blank SIM, AVCV, legal letter collection, address verification, biometric or field verification. |
| 3 **Processing** | The downstream execution stage once profiling and verification controls are passed: order creation, quality checks, commercial and contract validation, service delivery, lifecycle tracking. |
| 4 **Control tower** | Cross-process monitoring and orchestration: OCR and intelligent automation, ML and fraud analytics, entity monitoring, user management, bad-debt monitoring, RPA monitoring, fraud investigation, performance and efficiency tracking, SLA and ageing monitoring, exception and escalation management. |
| 5 **Governance** | Oversight of assurance across profiling, verifier and processing: auditing, validation and monitoring, process alignment, training, compliance. |
| 6 **Reporting** | Turns operational and governance data into management information. |

**Customer-facing intent categories** (the chat offers these eight, each with its requests and a ready-made question): authorised representative & company profile · correct or verify customer data · mobile and SIM requests · new service requests · change an existing service · move, transfer or port a service · renew or cease a service · verification, compliance or legal support.

**What the app does with them.** The catalog (`packages/domain/src/catalog.ts`) is the single source for the categories, request types, stage owner and standard queries. A request is chosen by clicking a category and a request, by clicking a pre-populated standard query, or by typing it (keyword recognition). *New LOA* runs end to end (this document). **Every other request type is captured and routed**: after the customer is identified, a case is recorded (`REQUEST_CAPTURED`, queue `VERIFIER_OPERATIONS` / `PROFILING_OPERATIONS` / `PROCESSING_ORDERS`), the customer is told plainly that it is not automated yet, and **no check runs and nothing is approved or changed**. A company that is not on record is a new lead whatever was asked. The *Operations* page shows the six stages, what runs on each, and the captured requests. Control tower, governance and reporting are shown for the operating model only.
## Product-owner answers (applied)

1. **Order.** The check order follows the process page (TL → identity → POA/MOA → bad debt → AVCV). *The product owner asked to re-check the order against the photographs; the message that asked contained no new image, so the order was re-read from the photographs already supplied and is unchanged. If the intended order differs, send the page or the order and it is a one-line change in `loaCheckCatalog` plus test updates.*
2. **AVCV = Address Verification and Credit Verification.** Built as two outcomes, one for the address and one for the credit profile, each one of: *positive* (verified), *negative/adverse*, *discrepancy*, *unable to verify*, *refer/review*, *insufficient information*. Mapping: any adverse → REJECT (recommended, human-confirmed); discrepancy → MANUAL_REVIEW; unable to verify or refer → MANUAL_REVIEW (**unable to verify is not a failure**); insufficient information → the chat asks for **proof of address** (utility bill or tenancy contract), then AVCV re-runs; both positive → pass. The check itself is a synthetic register: no field visit, GPS, photograph or credit-bureau lookup happens.
3. **Who is authorised without a POA/MOA** — broader than owner-only, narrower than "anyone on the Establishment Card". All five must hold: (1) ID verified; (2) recorded in the approved source as owner, manager with representative authority or authorised signatory; (3) the recorded capacity covers the requested action (account management, ordering, plan changes, signing commitments); (4) licence and registration current and consistent; (5) no conflicting evidence or limitation on the person's authority. A person who fails (2) or (3) needs a POA/MOA; a person with a recorded limitation (5) goes to a specialist and a POA cannot override it. Demo customers: Layth (manager, full authority → no POA), Ahmed (manager, partial authority → POA), Jamal (limitation → specialist), Omar (not recorded → POA).
4. **Rejection.** The agent recommends a rejection automatically, but it is never final and never communicated externally without human confirmation. The customer only sees "Awaiting specialist confirmation" (no reason, no rejection word, no internal route); the browser receives `PENDING_CONFIRMATION`; the reason, the SBO.11 draft and the SBO.20 root-cause analysis are on the review dashboard.
5. **Stage order and definitions:** see the operating model above. Only profiling's New LOA is automated.

## Remaining interpretations and simplifications

1. **SBO.05 (document extraction)** is folded into the chatbot's document request and the completeness gate, since page 13 does not draw it separately. The other pages use it.
2. **"Blue-collar behaviour"** is a flag on a linked party in the synthetic register.
3. **Names**: people match ignoring word order; companies match ignoring legal-form words. No fuzzy matching, so a misspelt name is a mismatch.
4. **Expiry**: a licence, Emirates ID or POA is expired if either the register or the printed date is in the past.
5. **A licence or ID that cannot be found in the register** is a *manual review*, never a rejection.
6. **Company recognition** at intake uses the trade-licence register only. A known company with an unknown person is assessed and ends in manual review (identity not found) unless the person is in the identity register.
7. **RCA (SBO.20)** is a deterministic summary keyed on the reason code, recorded on the audit trail and shown on the dashboard. **SBO.11** emails are drafts.

## Not built

- The other To-Be processes: Mobile Re-Registration, Document Update, Combo variants, Regularization, PMP, TASK/TKT, Data Quality Assurance.
- Automation of the verifier task, processing, control tower, governance and reporting (requests for them are captured and routed only).
- The ticket-triggered and channel-partner variants of New LOA (same five checks; different entry points and pending-information emails).
- SBO.05 as a stand-alone agent, SBO.12 system data checks / reconciliation, SBO.13 order execution, SBO.14 case lifecycle tracking.
- Any real integration (DUL API, government portal / UAE Pass, BCRM, AVCV field verification / credit bureau, e-mail).
- Pages 1–11 and 30–206 of the PDF were not seen.

## Open questions

1. Is the check order right? (Was SBO.12 system data check meant to run before bad debt?)
2. What is the exact list of permissions ("requested action") a New LOA can ask for? Four are assumed: manage account, order services, approve plan changes, sign commitments.
3. Which request type should be automated next (for example address verification in profiling, or MNP in the verifier task), and what are its checks?

## Retained n8n data

The n8n data files (dt_*.csv) are still preserved unchanged. Their businesses, people, authority letters, party records and mock results are also retained as synthetic registers: run `npm run import:n8n` to regenerate packages/domain/src/n8n-registers.ts, which is merged into the trade-licence, Emirates ID, POA/MOA, bad-debt and AVCV registers and adds 10 personas (slugs starting n8n-, e.g. Liam Chen at Bluegum Vector Demo Pty Ltd). Where the export had no named owner, a synthetic Director is generated. Duplicate CRM records raise BD-003 (DUPLICATE_RECORD_CONFLICT), an unavailable licence lookup raises TL-005, and a flagged authority letter raises POA-005 (DOCUMENT_SECURITY_REVIEW); all go to a human.


## Intake follow-ups, lead confirmation and reopening (product-owner request)

- **Full name:** a single-word name is asked for again as a full name (first and last name, as on the Emirates ID) before anything is created.
- **Lead confirmation:** a company that is not on record is not turned into a lead straight away. The chatbot asks the customer to confirm the name (yes = create the lead; a different name = carry on with that company; no = ask for the correct name). A confirmed lead is recorded with onboarding status **PENDING** (runtime status ONBOARDING_PENDING, audit LEAD_CAPTURED, queue PROFILING_OPERATIONS); the customer is told a representative will get back to onboard the business. Nothing is checked or approved.
- **Operations page:** the six stages are a stepper (click a stage for what it covers and its request types), with KPIs, the New LOA pipeline, new leads with onboarding status, captured requests and recent activity.
- **Reopening:** a reviewer can reopen any closed (completed) rejected / need-more-information / manual-review case from the dashboard. A returning customer whose earlier rejection a human already confirmed is told the case is closed and is asked for proof; only when documents are attached is it reopened as a new version (audit CASE_REOPENED, actor Customer (chat)) and reassessed. Before a human confirms, a rejection is never revealed and a returning customer simply starts a new case. Approved cases are not reopened.
