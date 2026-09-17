-- Schema. Every statement is idempotent; the poller applies all files in
-- migrations/ on boot (see src/lib/migrate.ts).

CREATE TABLE IF NOT EXISTS internships (
  id                   TEXT        PRIMARY KEY,
  title                TEXT        NOT NULL,
  company              TEXT        NOT NULL,
  location             TEXT        NOT NULL,
  description          TEXT,
  link                 TEXT        NOT NULL,
  source               TEXT        NOT NULL,
  posted_at            TIMESTAMPTZ NOT NULL,
  seen_at              TIMESTAMPTZ NOT NULL,
  score                INTEGER,
  score_label          TEXT,
  matched_keywords     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  archived             BOOLEAN     NOT NULL DEFAULT false,
  failed_check_count   INTEGER     NOT NULL DEFAULT 0,
  last_checked_at      TIMESTAMPTZ,
  multi_location       JSONB,
  salary_text          TEXT,
  salary_min           NUMERIC,
  salary_max           NUMERIC,
  salary_unit          TEXT,
  normalized_key       TEXT,
  season               JSONB
);

CREATE INDEX IF NOT EXISTS idx_internships_score          ON internships(score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_internships_source         ON internships(source);
CREATE INDEX IF NOT EXISTS idx_internships_seen_at        ON internships(seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_internships_archived       ON internships(archived);
CREATE INDEX IF NOT EXISTS idx_internships_score_label    ON internships(score_label);
CREATE INDEX IF NOT EXISTS idx_internships_company        ON internships(company);
CREATE INDEX IF NOT EXISTS idx_internships_normalized_key ON internships(normalized_key);
