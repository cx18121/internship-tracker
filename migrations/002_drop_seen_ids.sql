-- Drop the redundant `seen_ids` table. Every id that ever lived there was
-- also written to `internships.id` (the canonical primary key) in the same
-- transaction; the separate table only ever served as a slower duplicate
-- index. Worse, the dedup path read from `seen_ids` then UPDATEd
-- `internships` — if a row was ever deleted from `internships` but kept its
-- `seen_ids` entry (e.g. via the test-only _deleteInternshipForTest helper),
-- the UPDATE matched zero rows and the posting was silently dropped on the
-- next poll.
--
-- After this migration the dedup gate hits `internships.id` directly.
--
-- Apply via Railway shell:
--   psql $DATABASE_URL -f migrations/002_drop_seen_ids.sql
-- (or your usual deploy-time migration runner).

DROP TABLE IF EXISTS seen_ids;
