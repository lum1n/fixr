-- fixr schema v1. Timestamps are UTC ISO-8601 with whole seconds
-- (YYYY-MM-DDTHH:MM:SSZ), so they sort and compare as text.

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,  -- lowercase hex sha256 of the project key
  repo_path   TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  harness     TEXT NOT NULL,
  permission  TEXT NOT NULL,
  model       TEXT,                  -- NULL: harness default
  created_at  TEXT NOT NULL
);

CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,   -- report.id; a duplicate insert is a retried report
  project_id     TEXT NOT NULL REFERENCES projects(id),
  report_json    TEXT NOT NULL,
  screenshot_key TEXT,               -- R2 key jobs/<id>.png|jpg, NULL without screenshot
  state          TEXT NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued', 'claimed', 'running', 'done', 'blocked', 'error')),
  session_id     TEXT,
  pr_url         TEXT,
  detail         TEXT,
  claimed_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX jobs_state_created ON jobs (state, created_at);
CREATE INDEX jobs_session ON jobs (session_id);
