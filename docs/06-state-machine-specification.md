# State machine specification

Derived from the `status`, `current_stage` and `target_queue` values written by the n8n workflows (`dt_cases_runtime`), the evidence-request lifecycle (`dt_evidence_requests.status`), the human-review lifecycle (`dt_human_reviews.review_status`) and the historical runtime export. Values are the source's own strings; nothing was renamed.

Two states requested by the brief are **adapter states** that the source never persists: `INITIAL` (no `dt_cases_runtime` row yet — the status view reports it) and `ASSESSMENT_IN_PROGRESS` (only visible as an `ASSESSMENT_STARTED` audit event). Every other state below is a persisted source value.

## 1. Case (`dt_cases_runtime.status` / `current_stage` / `target_queue`)

| # | From | Trigger (workflow node) | Guard | To: status / current_stage / queue | Written by |
| --- | --- | --- | --- | --- | --- |
| C1 | *(none)* → `INITIAL` | – | case exists in `dt_synthetic_cases` | – (no runtime row; adapter state) | – |
| C2 | `INITIAL` / any | Chat `Evaluate <case>` (03 › Reset Runtime Utility Results) | valid `AUTH-\d{3}(-V\d+)?`, case exists | `ASSESSMENT_IN_PROGRESS` (audit only) | 03 |
| C3 | assessment | Finalizer selects `FINAL-001` | 7 mandatory checks PASS / PASS_WITH_FLAG | `READY_TO_PROCEED` / `DECISION_COMPLETE` / `ORDER_READINESS` | 90 › Upsert Runtime Case |
| C4 | assessment | Finalizer selects a `NEED_MORE_INFORMATION` rule | – | `WAITING_FOR_INFORMATION` / `CUSTOMER_ACTION` / rule queue | 90 |
| C5 | assessment | Finalizer selects a `MANUAL_REVIEW` rule or control CTRL-001/002/003 | – | `REVIEW_PENDING` / `HUMAN_REVIEW` / rule queue | 90 |
| C6 | assessment | Finalizer selects a `REJECT` rule | – | `REJECTION_CONFIRMATION_PENDING` / `HUMAN_CONFIRMATION` / rule queue | 90 |
| C7 | C4 or C5 (customer-remediable reason) | Classify Continuation → Create Evidence Request | reason ∈ remediable table | `WAITING_FOR_EVIDENCE` / `CUSTOMER_EVIDENCE` / `CUSTOMER_FOLLOW_UP` | 03 › Update Case to Waiting for Evidence |
| C8 | `WAITING_FOR_EVIDENCE` | Customer text/upload received | request OPEN / PARTIALLY_RECEIVED / INSUFFICIENT, exact request + case match | (case row unchanged; request → `RECEIVED`) | 03 / 96 |
| C9 | `WAITING_FOR_EVIDENCE` | Resolution EVID-001 (`ACCEPTED`) | valid structured resolution | `ASSESSMENT_RESUMED` / `AGENTIC_REASSESSMENT` / `SBO.02`, then C3–C6 from the next incomplete check | 03 › Update row(s) |
| C10 | `WAITING_FOR_EVIDENCE` | Resolution EVID-002, attempts left | `attempt_count + 1 < max_attempts` | unchanged (`WAITING_FOR_EVIDENCE`); request `INSUFFICIENT`; customer asked again | 95 |
| C11 | `WAITING_FOR_EVIDENCE` | EVID-002 with attempts exhausted | `attempt_count + 1 ≥ max_attempts` | `REVIEW_PENDING` / `HUMAN_REVIEW` / `EVIDENCE_REVIEW`, `human_review_required = true` | 03 › Update Case After Evidence Escalation |
| C12 | `WAITING_FOR_EVIDENCE` | Resolution EVID-003 (contradictory) | – (source switch is unreachable: G-04) | `REVIEW_PENDING` / `HUMAN_REVIEW` / `EVIDENCE_REVIEW` | 03 › Update Contradictory Evidence Case |
| C13 | `WAITING_FOR_EVIDENCE` | Customer types CANCEL/STOP/END/CANCEL REQUEST | request still active | `EVIDENCE_REQUEST_CANCELLED` / `CUSTOMER_EVIDENCE` / `CUSTOMER_FOLLOW_UP` | 03 › Update Cancelled Case |
| C14 | `REVIEW_PENDING` / `REJECTION_CONFIRMATION_PENDING` | Reviewer completes an **open** review | review `PENDING` or `PENDING_REJECTION_CONFIRMATION`, valid form, override reason when changing a REJECT recommendation | `READY_TO_PROCEED` (APPROVE), `WAITING_FOR_INFORMATION` (NEED_MORE_INFORMATION) or `REJECTED_CONFIRMED` (REJECT) / `HUMAN_REVIEW_COMPLETE` | 91 (persisted by the target; G-07) |
| C15 | `WAITING_FOR_INFORMATION` (decision NEED_MORE_INFORMATION) | Formal resubmission | original decision = NEED_MORE_INFORMATION; same `Case_ID`; higher `Submission_Version`; different `Case_Run_ID` | original: `SUPERSEDED_BY_RESUBMISSION` / `RESUBMITTED` / *revised case run id*; revised run enters C2 | 92 |

Terminal case states: `READY_TO_PROCEED`, `REJECTED_CONFIRMED`, `EVIDENCE_REQUEST_CANCELLED`, `SUPERSEDED_BY_RESUBMISSION`. `WAITING_FOR_INFORMATION` after a review NEED_MORE_INFORMATION is open-ended (no source transition out other than a resubmission).

Invalid transitions are refused, not ignored: completing a completed review (`REVIEW_ALREADY_COMPLETED`), submitting evidence to a non-open request (`EVIDENCE_REQUEST_NOT_OPEN`), resolving without new evidence (`NO_NEW_EVIDENCE_RECEIVED`), resubmitting a non-NMI or already-superseded case (`RESUBMISSION_NOT_ALLOWED` / `RESUBMISSION_ALREADY_CREATED`).

## 2. Evidence request (`dt_evidence_requests.status`)

```
              customer text / attachment                 EVID-001
   OPEN ─────────────────────────────▶ RECEIVED ─────────────▶ ACCEPTED
     │                                    │  ▲                    (resolved_at set)
     │                                    │  │ new text / PDF
     │                       EVID-002     │  │
     │                    attempts left   ▼  │
     │                              INSUFFICIENT
     │                                    │
     │             EVID-003 / attempts exhausted
     │                                    ▼
     │                               ESCALATED  (resolved_at set; evidence review created)
     └── CANCEL ───▶ CANCELLED (resolved_at set)   (also from RECEIVED / INSUFFICIENT)
```

`PARTIALLY_RECEIVED` is accepted as an input status (the source allows it) but nothing produces it (G-14). `FIXED` is never used. `max_attempts = 3`, `due_at = created_at + 48 h`. `attempt_count` increments only when a well-formed resolution is recorded; a malformed model output changes nothing.

## 3. Evidence record (`dt_case_evidence.validation_status`)

`RECEIVED` → `ACCEPTED` | `INSUFFICIENT` | `CONTRADICTORY` (set by Workflow 95 for rows that were `RECEIVED`; earlier `INSUFFICIENT` rows remain in scope for cumulative evaluation). `REJECTED` / `SUPERSEDED` rows are excluded from resolution.

## 4. Human review (`dt_human_reviews.review_status`)

`PENDING` | `PENDING_REJECTION_CONFIRMATION` (open) → `COMPLETED` (one-way; guarded by a row lock in PostgreSQL and a serialising lock in the in-memory store).

## 5. Utility result (`dt_utility_results_runtime`)

One **current** row per `case_run_id + submission_version + check_type` (unique index on active rows). A rerun replaces it; Workflow 95 replaces the originating check's row with an EVID-001/002/003 result; the chat-entry reset deletes exactly the case-run + version rows. Status vocabulary: `PASS`, `PASS_WITH_FLAG`, `FAIL`, `INCONCLUSIVE`, `NOT_RUN`.

## 6. Governed outcome vs provisional recommendation

Provisional (agent, advisory): `APPROVE | REJECT | NEED_MORE_INFORMATION | MANUAL_REVIEW`.
Governed (deterministic Finalizer, authoritative): the same four values. When they differ the runtime records `governance_override` and the message `The AI Agent recommended X, but deterministic policy recorded Y.` The governed outcome is never taken from the model.

## 7. Where the tests pin these transitions

`tests/regression.auth.test.ts` (C2–C7, C15 inputs), `tests/evidence.test.ts` (C8–C13, evidence lifecycle), `tests/review-resubmission-status.test.ts` (C14, C15, review lifecycle), `tests/persistence.test.ts` and `tests/sql.integration.test.ts` (utility-result contract), `tests/chat-audit.test.ts` (conversation transitions).
