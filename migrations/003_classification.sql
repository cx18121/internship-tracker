-- Model-based classification. company_profiles is judged once per company;
-- posting fields are set once per row. Score is derived from both.
CREATE TABLE IF NOT EXISTS company_profiles (
  company_key   TEXT        PRIMARY KEY,
  company       TEXT        NOT NULL,
  tier          TEXT        NOT NULL,
  sector        TEXT,
  known         BOOLEAN     NOT NULL DEFAULT false,
  reason        TEXT,
  model         TEXT,
  classified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE internships
  ADD COLUMN IF NOT EXISTS role_type     TEXT,
  ADD COLUMN IF NOT EXISTS degrees       JSONB,
  ADD COLUMN IF NOT EXISTS us_eligible   TEXT,
  ADD COLUMN IF NOT EXISTS is_internship BOOLEAN,
  ADD COLUMN IF NOT EXISTS company_tier  TEXT,
  ADD COLUMN IF NOT EXISTS classified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_internships_classified_at ON internships(classified_at);
