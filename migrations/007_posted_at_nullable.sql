-- posted_at is the publication date the source reported; NULL when the
-- source gave none. first_seen_at is when the tracker first stored the row
-- and never moves (seen_at is bumped on every rediscovery).
ALTER TABLE internships
  ALTER COLUMN posted_at DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
UPDATE internships SET first_seen_at = LEAST(posted_at, seen_at) WHERE first_seen_at IS NULL;
ALTER TABLE internships ALTER COLUMN first_seen_at SET NOT NULL;
ALTER TABLE internships ALTER COLUMN first_seen_at SET DEFAULT now();

-- These sources never report a publication date; their stored posted_at was
-- the poll time. Clear it so the UI marks the date as first-seen.
UPDATE internships SET posted_at = NULL WHERE source IN ('SimplifyJobs', 'Workday', 'iCIMS', 'Rippling', 'YC WaaS', 'Handshake');
