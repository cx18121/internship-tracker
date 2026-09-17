-- The tracker is read-only: no applied or hidden state per row.
ALTER TABLE internships
  DROP COLUMN IF EXISTS applied,
  DROP COLUMN IF EXISTS applied_at,
  DROP COLUMN IF EXISTS hidden,
  DROP COLUMN IF EXISTS first_failed_at;
DROP INDEX IF EXISTS idx_internships_hidden;
