-- Why a row was archived. Rediscovery by a poller only un-archives rows whose
-- reason is 'not seen'; rows rejected by the classifier or season rule stay out.
ALTER TABLE internships ADD COLUMN IF NOT EXISTS archive_reason TEXT;

-- Rows the classifier already rejected: record the reason so rediscovery
-- does not bring them back.
UPDATE internships SET archive_reason =
  CASE
    WHEN is_internship = false THEN 'not an internship'
    WHEN us_eligible = 'no' THEN 'outside the US'
    ELSE 'role ' || role_type
  END
WHERE archived AND archive_reason IS NULL AND classified_at IS NOT NULL
  AND (is_internship = false OR us_eligible = 'no' OR role_type NOT IN ('swe', 'ml_ai', 'data', 'quant', 'hardware_ee', 'research_science'));
