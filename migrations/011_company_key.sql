-- company_profiles and internships share a normalized company key
-- (src/lib/company-key.ts) so spelling variants get one judgment. Both are
-- rekeyed by the poller on boot (store.rekeyCompanies); the SELECT joins on
-- internships.company_key.
ALTER TABLE internships ADD COLUMN IF NOT EXISTS company_key TEXT;
CREATE INDEX IF NOT EXISTS internships_company_key_idx ON internships (company_key);
