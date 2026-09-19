-- Company catalog: structured facts about venture-backed companies, imported
-- from Sparrow (scripts/import-sparrow.ts). Facts feed the company judgment as
-- evidence; they are not shown or scored directly. Keyed by domain because
-- names collide; matched to postings by normalized name or ATS slug.
CREATE TABLE IF NOT EXISTS company_facts (
  domain        TEXT        PRIMARY KEY,
  name          TEXT        NOT NULL,
  name_key      TEXT        NOT NULL,
  stage         TEXT,
  investors     TEXT[]      NOT NULL DEFAULT '{}',
  batch         TEXT,
  headcount     INTEGER,
  industry      TEXT,
  location      TEXT,
  source        TEXT        NOT NULL,
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS company_facts_name_key_idx ON company_facts (name_key);
