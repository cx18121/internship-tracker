-- Initial Postgres schema.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS internships (
  id                   TEXT        PRIMARY KEY,
  title                TEXT        NOT NULL,
  company              TEXT        NOT NULL,
  location             TEXT        NOT NULL,
  description          TEXT,
  link                 TEXT        NOT NULL,
  source               TEXT        NOT NULL,
  ats_source           TEXT,
  ats_job_id           TEXT,
  ats_target           TEXT,
  posted_at            TIMESTAMPTZ NOT NULL,
  seen_at              TIMESTAMPTZ NOT NULL,
  score                INTEGER,
  score_label          TEXT,
  matched_keywords     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  is_new               BOOLEAN     NOT NULL DEFAULT true,
  applied              BOOLEAN     NOT NULL DEFAULT false,
  archived             BOOLEAN     NOT NULL DEFAULT false,
  applied_at           TIMESTAMPTZ,
  application_url      TEXT,
  application_status   TEXT,
  failed_check_count   INTEGER     NOT NULL DEFAULT 0,
  first_failed_at      TIMESTAMPTZ,
  last_checked_at      TIMESTAMPTZ,
  multi_location       JSONB,
  salary_text          TEXT,
  salary_min           NUMERIC,
  salary_max           NUMERIC,
  salary_unit          TEXT,
  normalized_key       TEXT,
  hidden               BOOLEAN     NOT NULL DEFAULT false,
  season               JSONB
);

CREATE INDEX IF NOT EXISTS idx_internships_score          ON internships(score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_internships_source         ON internships(source);
CREATE INDEX IF NOT EXISTS idx_internships_seen_at        ON internships(seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_internships_applied        ON internships(applied);
CREATE INDEX IF NOT EXISTS idx_internships_archived       ON internships(archived);
CREATE INDEX IF NOT EXISTS idx_internships_score_label    ON internships(score_label);
CREATE INDEX IF NOT EXISTS idx_internships_is_new         ON internships(is_new);
CREATE INDEX IF NOT EXISTS idx_internships_company        ON internships(company);
CREATE INDEX IF NOT EXISTS idx_internships_normalized_key ON internships(normalized_key);
CREATE INDEX IF NOT EXISTS idx_internships_hidden         ON internships(hidden);

CREATE TABLE IF NOT EXISTS seen_ids (
  id TEXT PRIMARY KEY
);
