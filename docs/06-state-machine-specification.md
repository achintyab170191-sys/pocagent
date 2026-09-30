# State machine specification (To-Be New LOA process)

Rewritten for the To-Be process (docs/09). The earlier state machine derived from the n8n export is in the git history. Values are persisted strings; the review dashboard and case-status page show them.

## 1. Conversation (`chat_sessions.step`, one per browser session)

```
IDLE ──"name + company"──▶ (company on record?)
  ▲                            ├─ no  ─▶ DONE   (new-lead case; nothing verified or approved)
  │                            └─ yes ─▶ AWAITING_EVIDENCE (document request open)
INTAKE ◀── asks only for what is missing (name, company)
AWAITING_EVIDENCE ──documents──▶ (complete?)  yes ─▶ checks run ─▶ DONE  |  NEED_MORE_INFORMATION (e.g. POA) ─▶ AWAITING_EVIDENCE
                              └─ no  ─▶ AWAITING_EVIDENCE (the missing documents are named; attempt n of 3)
AWAITING_EVIDENCE ──typed text──▶ AWAITING_EVIDENCE (refused: text is not evidence; no attempt spent)
AWAITING_EVIDENCE ──cancel──▶ DONE
DONE ──a reviewer reopens the case──▶ AWAITING_EVIDENCE (for the new version)
```

## 2. Case (`runtime_cases.status` / `current_stage` / `target_queue`)

| # | From | Trigger | Guard | To: status / stage / queue |
| --- | --- | --- | --- | --- |
| C1 | *(none)* | Customer names a company on record | – | case row only; `WAITING_FOR_EVIDENCE` / `CUSTOMER_EVIDENCE` / `CUSTOMER_FOLLOW_UP` once the document request opens |
| C1b | *(none)* | Customer names a company **not** on record | – | case row of type `NEW_LEAD`; no runtime case, no checks, no decision |
| C2 | `WAITING_FOR_EVIDENCE` | Documents complete (request `ACCEPTED`) | request open / received / insufficient | assessment starts; `ASSESSMENT_STARTED` audit |
| C3 | assessment | Finalizer selects `FINAL-001` | 5 mandatory checks PASS / PASS_WITH_FLAG | `READY_TO_PROCEED` / `DECISION_COMPLETE` / `ORDER_READINESS` |
| C4 | assessment | A check needs a document (`POA_MOA_MISSING`, `DOCUMENT_UNREADABLE`, `EID_EXPIRED`, `EID_UNREADABLE`) | – | `WAITING_FOR_EVIDENCE` / `CUSTOMER_EVIDENCE` / `CUSTOMER_FOLLOW_UP` (a new document request for that check) |
| C5 | `WAITING_FOR_EVIDENCE` | Documents for that check complete | – | that check's result is dropped and re-run; `ASSESSMENT_RESUMED`; then C3, C4, C6 or C7 from that check on |
| C6 | assessment | A check returns a `MANUAL_REVIEW` rule or control CTRL-001/002/003 | – | `REVIEW_PENDING` / `HUMAN_REVIEW` / rule queue; review created |
| C7 | assessment | A check returns a `REJECT` rule | – | `REJECTION_CONFIRMATION_PENDING` / `HUMAN_CONFIRMATION` / `REJECTION_REVIEW`; SBO.11 draft email; SBO.20 RCA on the audit trail; review created |
| C8 | `WAITING_FOR_EVIDENCE` | Three attempts and documents still missing | – | `REVIEW_PENDING` / `HUMAN_REVIEW` / `EVIDENCE_REVIEW`; review created; **no decision exists** |
| C9 | `WAITING_FOR_EVIDENCE` | Customer cancels | request active | `EVIDENCE_REQUEST_CANCELLED` |
| C10 | `REVIEW_PENDING` / `REJECTION_CONFIRMATION_PENDING` | Reviewer completes an open review | a decision exists; override reason to overturn a REJECT | `READY_TO_PROCEED` (APPROVE), `WAITING_FOR_INFORMATION` (NEED_MORE_INFORMATION) or `REJECTED_CONFIRMED` (REJECT) / `HUMAN_REVIEW_COMPLETE` |
| C11 | C4 / C6 / C7 / C8 or a completed NEED_MORE_INFORMATION review | Reviewer **reopens** the case | outcome ∈ {REJECT, NEED_MORE_INFORMATION, MANUAL_REVIEW}, or an open evidence review; not already reopened | original: `REOPENED_AS_NEW_VERSION` / `REOPENED` / *new case run id*; its open reviews become `CLOSED_REOPENED`; a **new case** `<id>-V<n+1>` starts at C1 with a new document request, and the customer's chat session is put back to `AWAITING_EVIDENCE` |

Terminal states: `READY_TO_PROCEED`, `REJECTED_CONFIRMED`, `EVIDENCE_REQUEST_CANCELLED`, `REOPENED_AS_NEW_VERSION`. A reviewed or reopened case is locked against re-evaluation (`CASE_LOCKED`).

Refused, not ignored: completing a completed review (`REVIEW_ALREADY_COMPLETED`), completing a review that has no decision (`DECISION_NOT_FOUND` — only reopen is possible), submitting to a closed request (`EVIDENCE_REQUEST_NOT_OPEN`), resolving without a new document (`NO_NEW_EVIDENCE_RECEIVED`), reopening an approved or already-reopened case (`REOPEN_NOT_ALLOWED`).

## 3. Evidence request (`evidence_requests.status`)

```
              documents attached                complete
   OPEN ─────────────────────────▶ RECEIVED ─────────────▶ ACCEPTED   (the originating check re-runs)
     │                                 │  ▲
     │                   incomplete    │  │ more documents
     │                  attempts left  ▼  │
     │                            INSUFFICIENT   (the missing documents are named)
     │                                 │
     │                  attempts exhausted (3)
     │                                 ▼
     │                            ESCALATED   (evidence review created)
     └── cancel ──▶ CANCELLED
```

`max_attempts = 3`, `due_at = created_at + 48 h`. An attempt is spent only when at least one new, readable, recognised document was received and the completeness check ran. A file that is unreadable or not an Emirates ID / Trade License / Establishment Card / POA-MOA is refused before anything is stored and spends nothing. What each request needs: `DOCUMENT_INTAKE` → Emirates ID + Trade License + Establishment Card; `TRADE_LICENSE_CHECK` → Trade License; `IDENTITY_VALIDATION` → Emirates ID; `POA_MOA_CHECK` → POA/MOA.

## 4. Evidence record (`case_evidence.validation_status`)

`RECEIVED` → `ACCEPTED` | `INSUFFICIENT`. Every record is a **document** (`FILE_UPLOAD`) with its classified type and the fields read from it (`structured_data.document_type`, `structured_data.fields`); the original file is stored outside any web root. There is no text evidence.

## 5. Human review (`human_reviews.review_status`)

`PENDING` | `PENDING_REJECTION_CONFIRMATION` (open) → `COMPLETED` (one-way, row-locked) or `CLOSED_REOPENED` (the case was reopened as a new version). All reviews appear on the dashboard by Review ID.

## 6. Utility result (`runtime_utility_results`)

One current row per `case_run_id + submission_version + check_type` (unique index on active rows). Check types: `TRADE_LICENSE_CHECK`, `IDENTITY_VALIDATION`, `POA_MOA_CHECK`, `BAD_DEBT_CHECK`, `AVCV_VERIFICATION`. A re-run replaces the row; when accepted documents answer a failed check, exactly that row is dropped so the assessment re-runs it. Status vocabulary: `PASS`, `PASS_WITH_FLAG`, `FAIL`, `INCONCLUSIVE`.

## 7. Governed outcome vs provisional recommendation

Provisional (agent, advisory): `APPROVE | REJECT | NEED_MORE_INFORMATION | MANUAL_REVIEW`. Governed (deterministic finalizer, authoritative): the same four values. When they differ the runtime records `governance_override`. The governed outcome is never taken from the model.

## 8. Where the tests pin these transitions

`tests/loa-process.test.ts` (conversation, evidence loop, the five checks, dashboard, reopen), `tests/governance.test.ts` (finalizer), `tests/persistence.test.ts` and `tests/sql.integration.test.ts` (utility-result contract, whole process on SQL), `tests/api.test.ts` and `tests/security.test.ts` (HTTP, concurrency, hardening), `tests/e2e/portal.spec.ts` (browser).
