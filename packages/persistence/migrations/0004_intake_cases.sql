-- Cases opened from the intake conversation ("my name is … I represent …"). They are runtime state (created by users), not fixtures.
-- template_case_run_id names the synthetic scenario whose pre-computed utility results the case is assessed against ('' = no scenario matched).
CREATE TABLE IF NOT EXISTS intake_cases (
  case_run_id TEXT PRIMARY KEY,
  template_case_run_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- AUTH-101, AUTH-102 … never collide with the AUTH-001…010 fixtures.
CREATE SEQUENCE IF NOT EXISTS intake_case_seq START 101 MINVALUE 101 MAXVALUE 999;
