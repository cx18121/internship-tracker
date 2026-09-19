-- Stable job identity derived from the link (src/lib/job-key.ts), so the same
-- ATS job reached through different URLs is one row.
ALTER TABLE internships ADD COLUMN IF NOT EXISTS job_key TEXT;
CREATE INDEX IF NOT EXISTS internships_job_key_idx ON internships (job_key) WHERE archived = false;
