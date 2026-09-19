/** Company side of the store: judged profiles, the fact catalog, and key upkeep. */
import { getPool } from '../db';
import type { CompanyTier, CompanyProfile, CompanyFacts } from '../classify/company';
import { companyKey } from '../company-key';
import { normalizeKey } from '../normalize-key';

export async function getCompanyProfiles(keys: string[]): Promise<Map<string, CompanyProfile & { tier: CompanyTier }>> {
  if (keys.length === 0) return new Map();
  const { rows } = await getPool().query<{ company_key: string; tier: CompanyTier; sector: string | null; known: boolean; reason: string | null }>(
    'SELECT company_key, tier, sector, known, reason FROM company_profiles WHERE company_key = ANY($1::text[])', [keys],
  );
  return new Map(rows.map(r => [r.company_key, { tier: r.tier, sector: r.sector ?? '', known: r.known, reason: r.reason ?? '' }]));
}

/** Lower-cased names of companies the classifier judged worth following. */
export async function getPromotedCompanyKeys(): Promise<Set<string>> {
  const { rows } = await getPool().query<{ company_key: string }>("SELECT company_key FROM company_profiles WHERE tier IN ('elite', 'top', 'hot')");
  return new Set(rows.map(r => r.company_key));
}

export async function saveCompanyProfile(key: string, company: string, p: CompanyProfile, model: string): Promise<void> {
  await getPool().query(
    `INSERT INTO company_profiles (company_key, company, tier, sector, known, reason, model, classified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (company_key) DO UPDATE SET company = EXCLUDED.company, tier = EXCLUDED.tier, sector = EXCLUDED.sector,
       known = EXCLUDED.known, reason = EXCLUDED.reason, model = EXCLUDED.model, classified_at = now()`,
    [key, company, p.tier, p.sector, p.known, p.reason, model],
  );
}

const FACTS_SELECT = 'SELECT domain, stage, investors, batch, headcount, industry, location FROM company_facts';

/** Catalog facts for a company, matched by normalized name or by ATS slug against the domain stem. */
export async function findCompanyFacts(company: string, atsSlug?: string): Promise<CompanyFacts | null> {
  const nameKey = companyKey(company);
  const stems = atsSlug ? [atsSlug.toLowerCase(), atsSlug.toLowerCase().replace(/-/g, '')] : [];
  if (!nameKey && stems.length === 0) return null;
  const { rows } = await getPool().query<CompanyFacts>(
    `${FACTS_SELECT} WHERE ($1 <> '' AND name_key = $1) OR split_part(domain, '.', 1) = ANY($2::text[])
     ORDER BY (name_key = $1) DESC, headcount DESC NULLS LAST LIMIT 1`,
    [nameKey, stems],
  );
  return rows[0] ?? null;
}

export async function upsertCompanyFacts(rows: Array<CompanyFacts & { name: string; source: string }>): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await getPool().query(
    `INSERT INTO company_facts (domain, name, name_key, stage, investors, batch, headcount, industry, location, source)
     SELECT domain, name, name_key, stage, investors, batch, headcount, industry, location, source
     FROM jsonb_to_recordset($1::jsonb) AS x(domain text, name text, name_key text, stage text, investors text[], batch text, headcount int, industry text, location text, source text)
     ON CONFLICT (domain) DO UPDATE SET name = EXCLUDED.name, name_key = EXCLUDED.name_key, stage = EXCLUDED.stage, investors = EXCLUDED.investors,
       batch = EXCLUDED.batch, headcount = EXCLUDED.headcount, industry = EXCLUDED.industry, location = EXCLUDED.location, source = EXCLUDED.source, imported_at = now()`,
    [JSON.stringify(rows.map(r => ({ ...r, name_key: companyKey(r.name) })))],
  );
  return res.rowCount ?? 0;
}

/**
 * Keys derived from names (company_key, normalized_key) are recomputed on
 * boot so a change to companyKey or normalizeKey applies to stored rows.
 * Profiles that collapse onto one key keep the curated one, else the latest
 * judgment. Idempotent; a no-op once every row carries the current keys.
 */
export async function rekeyRows(): Promise<{ internships: number; profiles: number }> {
  const p = getPool();
  const rows = (await p.query<{ id: string; company: string; title: string; company_key: string | null; normalized_key: string | null }>(
    'SELECT id, company, title, company_key, normalized_key FROM internships')).rows
    .map(r => ({ id: r.id, ck: companyKey(r.company), nk: normalizeKey(r.company, r.title), r }))
    .filter(x => x.ck !== x.r.company_key || x.nk !== x.r.normalized_key);
  if (rows.length > 0) {
    await p.query('UPDATE internships i SET company_key = x.ck, normalized_key = x.nk FROM jsonb_to_recordset($1::jsonb) AS x(id text, ck text, nk text) WHERE i.id = x.id',
      [JSON.stringify(rows.map(x => ({ id: x.id, ck: x.ck, nk: x.nk })))]);
  }
  const profiles = (await p.query<{ company_key: string; company: string }>('SELECT company_key, company FROM company_profiles')).rows
    .filter(r => companyKey(r.company) !== r.company_key);
  if (profiles.length > 0) {
    await p.query(`
      WITH moved AS (
        SELECT x.k AS new_key, p.* FROM company_profiles p JOIN jsonb_to_recordset($1::jsonb) AS x(old text, k text) ON x.old = p.company_key
      ), ranked AS (
        SELECT *, row_number() OVER (PARTITION BY new_key ORDER BY (model = 'curated') DESC, classified_at DESC) AS rn FROM moved
      ), deleted AS (
        DELETE FROM company_profiles WHERE company_key IN (SELECT company_key FROM moved)
      )
      INSERT INTO company_profiles (company_key, company, tier, sector, known, reason, model, classified_at)
      SELECT new_key, company, tier, sector, known, reason, model, classified_at FROM ranked WHERE rn = 1
      ON CONFLICT (company_key) DO UPDATE SET tier = EXCLUDED.tier, sector = EXCLUDED.sector, known = EXCLUDED.known, reason = EXCLUDED.reason,
        model = EXCLUDED.model, classified_at = EXCLUDED.classified_at
      WHERE company_profiles.model <> 'curated' OR EXCLUDED.model = 'curated'`,
      [JSON.stringify(profiles.map(r => ({ old: r.company_key, k: companyKey(r.company) })))]);
  }
  return { internships: rows.length, profiles: profiles.length };
}

