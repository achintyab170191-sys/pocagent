-- Integrity constraints for the runtime baseline.
-- The active-row uniqueness on (case_run_id, submission_version, check_type) already exists (0001). These checks make the key well-formed,
-- so a blank or mixed-case check_type can never create a second "active" row for the same logical check.
ALTER TABLE runtime_utility_results
  ADD CONSTRAINT runtime_utility_results_key_wellformed
  CHECK (btrim(case_run_id) <> '' AND submission_version >= 1 AND btrim(check_type) <> '' AND check_type = upper(check_type) AND sequence >= 0);

-- payload must carry the same identity as the key columns (prevents a row whose key says one check and whose body says another).
ALTER TABLE runtime_utility_results
  ADD CONSTRAINT runtime_utility_results_payload_matches_key
  CHECK (payload->>'caseRunId' = case_run_id AND (payload->>'submissionVersion')::int = submission_version AND upper(payload->>'checkType') = check_type);

-- Exactly one governed decision per case run; runtime case rows are keyed by case run.
CREATE INDEX IF NOT EXISTS evidence_requests_case_idx ON evidence_requests (case_run_id);
CREATE INDEX IF NOT EXISTS case_evidence_request_idx ON case_evidence (evidence_request_id) WHERE superseded = FALSE;
CREATE INDEX IF NOT EXISTS human_reviews_case_idx ON human_reviews (case_run_id);
CREATE INDEX IF NOT EXISTS communications_case_idx ON communications (case_run_id);
CREATE INDEX IF NOT EXISTS audit_events_case_idx ON audit_events (case_run_id, created_at);
