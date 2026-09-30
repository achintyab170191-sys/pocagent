# Post-parity enhancements (NOT implemented)

> **ARCHIVED (docs/09).** This document analyses the earlier n8n export, which the To-Be process diagrams have replaced as the source of truth. It is kept as reference only and is not maintained.

Nothing on this page changes behaviour today. Each item needs a traceability update and a regression test before it is built (rule in `CLAUDE.md`).

## 1. Exception-level review dispositions and automatic resumption (recommended first)

**Today (source parity).** Workflow 91 offers three final dispositions — `APPROVE`, `NEED_MORE_INFORMATION`, `REJECT` — that overwrite the case's final outcome. A reviewer who has resolved the *one* exception that caused a manual review cannot say "this check is now fine, continue the remaining checks"; choosing `APPROVE` approves the whole case and skips the remaining mandatory checks.

**Proposal.** Add exception-level dispositions such as `RESOLVED_PASS` (the flagged exception is resolved; treat the originating check as PASS with a reviewer-attributed rule), `RESOLVED_FAIL`, `REQUEST_EVIDENCE`, and `ESCALATE`. After `RESOLVED_PASS`:

1. write a `PASS` utility row for the originating `check_type` with `rule_ids = ['REV-…']`, reviewer identity and comments (same three-part key, so it replaces only that check);
2. automatically call `resumeAssessment` so the remaining mandatory checks run from the next incomplete one, ending at the normal governed outcome;
3. keep every governed decision deterministic; the reviewer supplies evidence, not the final outcome.

**Why not now.** It changes 91's behaviour and the meaning of `dt_human_reviews.reviewer_decision`. The uploaded 91 has no such disposition; per the brief it must be documented and ported only if it appears in an uploaded newer workflow.

**Tests to add first:** review with `RESOLVED_PASS` resumes to APPROVE on a complete fixture; resumes to `MANDATORY_CHECKS_INCOMPLETE` on AUTH-003's real fixture; duplicate-submission guard unchanged; audit trail shows reviewer as actor of the replaced check.

## 2. Make the AUTH-002 / AUTH-003 evidence loops convergent

Doc 07 G-11/G-12: the failing check and the evidence's originating check differ (AUTH-002), and AUTH-003's downstream fixtures are `NOT_RUN`. Options: derive `originating_check_type` from the *failing check* rather than the reason-code table; add post-evidence fixture rows for AUTH-003. Both need a process-owner decision.

## 3. Reviewer identity and access control

Reviewer name is a free-text form field in the source. Add authenticated reviewers (SSO), role-based access to `/review`, and bind `reviewer_name` to the session. Add optional four-eyes approval for REJECT confirmation.

## 4. Real communications (behind explicit approval)

Communications are drafts. If sending is ever in scope: an approval queue (`approved_at`, `sent_at` columns already exist in `dt_communications`), a provider adapter, idempotent send with a `sent` audit event, and PII-safe logging.

## 5. Operational hardening

- Object storage (S3-compatible) with server-side encryption and lifecycle rules instead of a local `UPLOAD_DIR`; antivirus scan before extraction.
- OCR for scanned PDFs (explicitly unsupported today, as in the source).
- Structured logging with correlation ids from `session_id` / `case_run_id`; OpenTelemetry traces around each tool call.
- Replace the JSONB-payload runtime tables with fully relational columns once the domain model is stable (keys and CHECK constraints already exist).
- Server-side rendering of the curated chat response so the UI never parses markdown.
- Rate limiting keyed by session as well as IP; CAPTCHA on public forms.

## 6. Agent quality

- Evaluation harness that replays the AUTH cases against the live model and asserts the tool sequence (today only the guarded toolbox and the deterministic Finalizer guarantee correctness).
- Prompt-injection red-team corpus for evidence text and PDFs, run against the evidence-resolution prompt.
- Cost/latency budget per assessment; prompt caching for the static system prompt.

## 7. Data model

- Treat `Case_Run_ID` + `Submission_Version` uniformly (the source mixes `case_Run_ID`, `case_run_id`, `Case_Run_ID`).
- Add `execution_id`/`correlation_id` to every runtime table.
