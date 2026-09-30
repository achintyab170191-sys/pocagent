CREATE TABLE IF NOT EXISTS runtime_utility_results (
  case_run_id TEXT NOT NULL,
  submission_version INTEGER NOT NULL,
  check_type TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  superseded BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_utility_results_active_unique
  ON runtime_utility_results(case_run_id, submission_version, check_type)
  WHERE superseded = FALSE;

CREATE TABLE IF NOT EXISTS runtime_cases (case_run_id TEXT PRIMARY KEY, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS decisions (case_run_id TEXT PRIMARY KEY, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS evidence_requests (evidence_request_id TEXT PRIMARY KEY, case_run_id TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS case_evidence (evidence_id TEXT PRIMARY KEY, evidence_request_id TEXT NOT NULL, superseded BOOLEAN NOT NULL DEFAULT FALSE, payload JSONB NOT NULL, provided_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS human_reviews (review_id TEXT PRIMARY KEY, case_run_id TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS communications (communication_id TEXT PRIMARY KEY, case_run_id TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_events (event_id TEXT PRIMARY KEY, case_run_id TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
