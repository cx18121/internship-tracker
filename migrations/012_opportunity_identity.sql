-- Source-posting aliases and opening-local evidence survive later polling cycles.
-- This is not an employer alias catalog and does not affect company ratings.
ALTER TABLE internships ADD COLUMN IF NOT EXISTS identities JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS internships_identities_idx ON internships USING GIN (identities jsonb_path_ops);
