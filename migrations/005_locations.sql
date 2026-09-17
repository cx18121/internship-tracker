-- Every location a posting lists, and the metros they map to (src/lib/metros.ts).
ALTER TABLE internships
  ADD COLUMN IF NOT EXISTS locations JSONB,
  ADD COLUMN IF NOT EXISTS metros    JSONB;

-- Seed locations from the legacy multi_location column where it exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'internships' AND column_name = 'multi_location') THEN
    UPDATE internships SET locations = COALESCE(multi_location, jsonb_build_array(location)) WHERE locations IS NULL;
    ALTER TABLE internships DROP COLUMN multi_location;
  END IF;
END $$;
UPDATE internships SET locations = jsonb_build_array(location) WHERE locations IS NULL;
