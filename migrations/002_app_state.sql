-- Shared poller/web state (notification settings, poll stats, source-fetch
-- history, source-down alerts). Replaces the JSON sidecars under data/.
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Columns nothing reads or writes any more.
ALTER TABLE internships
  DROP COLUMN IF EXISTS is_new,
  DROP COLUMN IF EXISTS application_url,
  DROP COLUMN IF EXISTS application_status,
  DROP COLUMN IF EXISTS ats_source,
  DROP COLUMN IF EXISTS ats_job_id,
  DROP COLUMN IF EXISTS ats_target;
DROP INDEX IF EXISTS idx_internships_is_new;
DROP INDEX IF EXISTS idx_internships_applied;
