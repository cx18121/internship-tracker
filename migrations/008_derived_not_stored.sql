-- Score, metros, matched keywords, and the company tier are derived from
-- other columns and company_profiles at read time (src/lib/present.ts).
ALTER TABLE internships
  DROP COLUMN IF EXISTS score,
  DROP COLUMN IF EXISTS score_label,
  DROP COLUMN IF EXISTS matched_keywords,
  DROP COLUMN IF EXISTS metros,
  DROP COLUMN IF EXISTS company_tier;
DROP INDEX IF EXISTS idx_internships_score;
DROP INDEX IF EXISTS idx_internships_score_label;
CREATE INDEX IF NOT EXISTS idx_company_profiles_key ON company_profiles(company_key);
