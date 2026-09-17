import type { PoolClient } from 'pg';
import { getPool } from './db';
import type { Internship, ScoreLabel } from './types';
import type { RoleType, Degree, PostingClassification } from './classify/posting';
import type { CompanyTier, CompanyProfile } from './classify/company';
import type { Metro } from './metros';
import type { Salary } from './salary';
import { getState, setState } from './app-state';

// ---------------------------------------------------------------------------
// Row mapping. COLUMNS is the single description of how an Internship maps to
// the internships table; insert, rediscovery backfill, and read all derive
// from it.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string | null;
  link: string;
  source: string;
  posted_at: Date;
  seen_at: Date;
  score: number | null;
  score_label: ScoreLabel | null;
  matched_keywords: string[];
  archived: boolean;
  failed_check_count: number;
  last_checked_at: Date | null;
  locations: string[] | null;
  metros: Metro[] | null;
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_unit: Salary['unit'];
  normalized_key: string | null;
  season: string[] | null;
  role_type: RoleType | null;
  degrees: Degree[] | null;
  us_eligible: 'yes' | 'no' | 'unclear' | null;
  is_internship: boolean | null;
  company_tier: CompanyTier | null;
  classified_at: Date | null;
}

const COLUMNS: ReadonlyArray<[keyof Row, (i: Internship) => unknown]> = [
  ['id', i => i.id],
  ['title', i => i.title],
  ['company', i => i.company],
  ['location', i => i.location],
  ['description', i => i.description ?? null],
  ['link', i => i.link],
  ['source', i => i.source],
  ['posted_at', i => i.postedAt],
  ['seen_at', i => i.seenAt],
  ['score', i => i.score],
  ['score_label', i => i.scoreLabel],
  ['matched_keywords', i => JSON.stringify(i.matchedKeywords)],
  ['archived', i => i.archived],
  ['failed_check_count', i => i.failedCheckCount],
  ['last_checked_at', i => i.lastCheckedAt ?? null],
  ['locations', i => JSON.stringify(i.locations)],
  ['metros', i => JSON.stringify(i.metros)],
  ['salary_text', i => i.salaryText ?? null],
  ['salary_min', i => i.salaryMin ?? null],
  ['salary_max', i => i.salaryMax ?? null],
  ['salary_unit', i => i.salaryUnit ?? null],
  ['normalized_key', i => i.normalizedKey],
  ['season', i => JSON.stringify(i.season)],
  ['role_type', i => i.roleType ?? null],
  ['degrees', i => i.degrees ? JSON.stringify(i.degrees) : null],
  ['us_eligible', i => i.usEligible ?? null],
  ['is_internship', i => i.isInternship ?? null],
  ['company_tier', i => i.companyTier ?? null],
  ['classified_at', i => i.classifiedAt ?? null],
];

const COL_NAMES = COLUMNS.map(([c]) => c);
const INSERT_SQL = `INSERT INTO internships (${COL_NAMES.join(',')}) VALUES (${COL_NAMES.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`;

function toValues(i: Internship): unknown[] {
  return COLUMNS.map(([, get]) => get(i));
}

const iso = (d: Date | null): string | undefined => d?.toISOString();

function fromRow(r: Row): Internship {
  return {
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    description: r.description ?? undefined,
    link: r.link,
    source: r.source,
    postedAt: r.posted_at.toISOString(),
    seenAt: r.seen_at.toISOString(),
    score: r.score,
    scoreLabel: r.score_label,
    matchedKeywords: r.matched_keywords ?? [],
    archived: r.archived,
    failedCheckCount: r.failed_check_count,
    lastCheckedAt: iso(r.last_checked_at),
    locations: r.locations ?? (r.location ? [r.location] : []),
    metros: r.metros ?? [],
    salaryText: r.salary_text ?? undefined,
    salaryMin: r.salary_min ?? undefined,
    salaryMax: r.salary_max ?? undefined,
    salaryUnit: r.salary_unit ?? undefined,
    normalizedKey: r.normalized_key ?? '',
    season: r.season ?? [],
    roleType: r.role_type ?? undefined,
    degrees: r.degrees ?? undefined,
    usEligible: r.us_eligible ?? undefined,
    isInternship: r.is_internship ?? undefined,
    companyTier: r.company_tier ?? undefined,
    classifiedAt: iso(r.classified_at),
  };
}

// ---------------------------------------------------------------------------
// Write serialization. One in-process mutex so the poll cycle's transaction
// and UI patches never interleave; one transaction helper for multi-statement
// writes.
// ---------------------------------------------------------------------------

let storeLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = storeLock.then(fn);
  storeLock = next.catch(() => {});
  return next;
}

async function withTxn<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListFilters {
  source?: string;
  sources?: string[];
  minScore?: number;
  label?: string;
  includeArchived?: boolean;
  sort?: 'newest' | 'posted' | 'score';
  search?: string;
}

export async function getInternships(filters: ListFilters = {}): Promise<Internship[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (!filters.includeArchived) where.push('archived = false');
  if (filters.sources && filters.sources.length > 0) {
    where.push(`LOWER(source) = ANY(${p(filters.sources.map(s => s.toLowerCase()))}::text[])`);
  } else if (filters.source) {
    where.push(`LOWER(source) = ${p(filters.source.toLowerCase())}`);
  }
  if (filters.minScore !== undefined) where.push(`COALESCE(score, 0) >= ${p(filters.minScore)}`);
  if (filters.label) where.push(`LOWER(score_label) = ${p(filters.label.toLowerCase())}`);
  if (filters.search) {
    const q = p(`%${filters.search.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(LOWER(title) LIKE ${q} ESCAPE '\\' OR LOWER(company) LIKE ${q} ESCAPE '\\' OR LOWER(location) LIKE ${q} ESCAPE '\\')`);
  }

  const orderBy = filters.sort === 'newest' ? 'seen_at DESC'
    : filters.sort === 'posted' ? 'posted_at DESC'
    : 'COALESCE(score, 0) DESC';

  const sql = `SELECT * FROM internships${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy}`;
  const { rows } = await getPool().query<Row>(sql, params);
  return rows.map(fromRow);
}

export async function getInternship(id: string): Promise<Internship | null> {
  const { rows } = await getPool().query<Row>('SELECT * FROM internships WHERE id = $1', [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export interface SourceHealthRow {
  name: string;
  total: number;
  last24h: number;
  last7d: number;
  lastSeenAt: string | null;
}

export async function getSourceHealth(): Promise<SourceHealthRow[]> {
  const { rows } = await getPool().query<{ source: string; total: string; last24h: string; last7d: string; last_seen: Date | null }>(`
    SELECT source,
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE seen_at > now() - interval '1 day')::text AS last24h,
           COUNT(*) FILTER (WHERE seen_at > now() - interval '7 days')::text AS last7d,
           MAX(seen_at) AS last_seen
    FROM internships GROUP BY source`);
  return rows.map(r => ({
    name: r.source,
    total: +r.total,
    last24h: +r.last24h,
    last7d: +r.last7d,
    lastSeenAt: r.last_seen?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Poll stats (app_state) and aggregate stats
// ---------------------------------------------------------------------------

export interface PollStats {
  polledAt: string;
  /** Raw rows fetched per source in the last cycle that polled it. */
  sourceCounts: Record<string, number>;
  /** Net-new rows per source in the last cycle that polled it. */
  netNewBySource: Record<string, number>;
  exclusionCounts: Record<string, number>;
}

const EMPTY_POLL_STATS: PollStats = { polledAt: '', sourceCounts: {}, netNewBySource: {}, exclusionCounts: {} };

export async function getPollStats(): Promise<PollStats> {
  return getState('poll-stats', EMPTY_POLL_STATS);
}

/** Per-source counts merge with the previous cycle so a fast-tier cycle
 *  doesn't blank the slow-tier sources it didn't poll. */
export async function savePollStats(stats: PollStats): Promise<void> {
  const prev = await getPollStats();
  await setState('poll-stats', {
    polledAt: stats.polledAt,
    sourceCounts: { ...prev.sourceCounts, ...stats.sourceCounts },
    netNewBySource: { ...prev.netNewBySource, ...stats.netNewBySource },
    exclusionCounts: stats.exclusionCounts,
  });
}

export async function getStats(): Promise<{
  total: number;
  bySource: Record<string, number>;
  byLabel: Record<string, number>;
  lastPolledAt: string | null;
  exclusionCounts: Record<string, number>;
  lastCycleSourceCounts: Record<string, number>;
  lastCycleNetNewBySource: Record<string, number>;
}> {
  const pool = getPool();
  const [bySourceR, byLabelR, lastSeenR, poll] = await Promise.all([
    pool.query<{ source: string; n: string }>('SELECT source, COUNT(*)::text AS n FROM internships GROUP BY source'),
    pool.query<{ score_label: string | null; n: string }>('SELECT score_label, COUNT(*)::text AS n FROM internships GROUP BY score_label'),
    pool.query<{ seen_at: Date }>('SELECT MAX(seen_at) AS seen_at FROM internships'),
    getPollStats(),
  ]);
  const bySource: Record<string, number> = {};
  for (const r of bySourceR.rows) bySource[r.source] = +r.n;
  const byLabel: Record<string, number> = {};
  for (const r of byLabelR.rows) byLabel[r.score_label ?? 'unscored'] = +r.n;
  return {
    total: Object.values(bySource).reduce((a, b) => a + b, 0),
    bySource,
    byLabel,
    lastPolledAt: lastSeenR.rows[0]?.seen_at?.toISOString() ?? null,
    exclusionCounts: poll.exclusionCounts,
    lastCycleSourceCounts: poll.sourceCounts,
    lastCycleNetNewBySource: poll.netNewBySource,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface StoreResult {
  newInternships: Internship[];
  totalStored: number;
  netNewBySource: Record<string, number>;
}

// Rediscovery of a stored row (same id, or same company+title via another
// source). Bumps seen_at, re-scores with the current config, and backfills
// fields that were null. A row archived because no poller had seen it comes
// back; one rejected by the classifier, the season rule, or a dead-link check
// stays archived. The stored link is preserved.
const BACKFILL_SQL = `
  UPDATE internships SET
    seen_at          = $1,
    archived         = CASE WHEN failed_check_count > 0 OR (archive_reason IS NOT NULL AND archive_reason <> 'not seen') THEN archived ELSE false END,
    archive_reason   = CASE WHEN failed_check_count > 0 OR (archive_reason IS NOT NULL AND archive_reason <> 'not seen') THEN archive_reason ELSE NULL END,
    score            = $2,
    score_label      = $3,
    matched_keywords = $4,
    description      = COALESCE(NULLIF(description, ''), $5),
    salary_text      = COALESCE(salary_text, $6),
    salary_min       = COALESCE(salary_min,  $7),
    salary_max       = COALESCE(salary_max,  $8),
    salary_unit      = COALESCE(salary_unit, $9),
    locations        = $10,
    metros           = $11,
    location         = $12,
    normalized_key   = COALESCE(normalized_key, $13)
  WHERE id = $14`;

function backfillArgs(i: Internship, targetId: string): unknown[] {
  return [
    i.seenAt, i.score, i.scoreLabel, JSON.stringify(i.matchedKeywords),
    i.description ?? null, i.salaryText ?? null, i.salaryMin ?? null, i.salaryMax ?? null, i.salaryUnit ?? null,
    JSON.stringify(i.locations), JSON.stringify(i.metros), i.location, i.normalizedKey, targetId,
  ];
}

/**
 * Insert never-seen postings and refresh rediscovered ones. Dedup keys, in
 * order: id (md5 of company+title+link), exact link, normalizedKey
 * (company + normalized title, catches the same role from another source).
 * When a stored simplify.jobs wrapper link is rediscovered with a direct ATS
 * URL, the stored link is upgraded.
 */
export async function deduplicateAndStore(incoming: Internship[]): Promise<StoreResult> {
  return withLock(() => withTxn(async (client) => {
    const existing = (await client.query<{ id: string; link: string; normalized_key: string | null }>(
      'SELECT id, link, normalized_key FROM internships WHERE archived = false',
    )).rows;
    const seenLinks = new Set(existing.map(r => r.link).filter(Boolean));
    const rowByKey = new Map<string, { id: string; link: string }>();
    for (const r of existing) if (r.normalized_key) rowByKey.set(r.normalized_key, { id: r.id, link: r.link });

    const newInternships: Internship[] = [];
    const netNewBySource: Record<string, number> = {};

    for (const i of incoming) {
      const byId = await client.query('SELECT 1 FROM internships WHERE id = $1', [i.id]);
      if (byId.rowCount) {
        await client.query(BACKFILL_SQL, backfillArgs(i, i.id));
        continue;
      }
      if (seenLinks.has(i.link)) continue;

      const sameRole = rowByKey.get(i.normalizedKey);
      if (sameRole) {
        await client.query(BACKFILL_SQL, backfillArgs(i, sameRole.id));
        if (sameRole.link.includes('simplify.jobs') && !i.link.includes('simplify.jobs')) {
          await client.query('UPDATE internships SET link = $2 WHERE id = $1', [sameRole.id, i.link]);
          rowByKey.set(i.normalizedKey, { id: sameRole.id, link: i.link });
          seenLinks.add(i.link);
        }
        continue;
      }

      await client.query(INSERT_SQL, toValues(i));
      seenLinks.add(i.link);
      rowByKey.set(i.normalizedKey, { id: i.id, link: i.link });
      newInternships.push(i);
      netNewBySource[i.source] = (netNewBySource[i.source] ?? 0) + 1;
    }

    const count = await client.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM internships');
    return { newInternships, totalStored: +count.rows[0].n, netNewBySource };
  }));
}

export async function archiveInternshipsByIds(ids: string[], reason: string): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await getPool().query('UPDATE internships SET archived = true, archive_reason = $2 WHERE id = ANY($1::text[])', [ids, reason]);
  return result.rowCount ?? 0;
}

export async function deleteInternship(id: string): Promise<void> {
  await getPool().query('DELETE FROM internships WHERE id = $1', [id]);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

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

export interface ClassificationUpdate extends PostingClassification {
  companyTier: CompanyTier;
  score: number;
  scoreLabel: ScoreLabel;
  matchedKeywords: string[];
}

export async function saveClassification(id: string, c: ClassificationUpdate): Promise<void> {
  await getPool().query(
    `UPDATE internships SET role_type = $2, degrees = $3, us_eligible = $4, is_internship = $5, company_tier = $6,
       score = $7, score_label = $8, matched_keywords = $9, classified_at = now() WHERE id = $1`,
    [id, c.roleType, JSON.stringify(c.degrees), c.usEligible, c.isInternship, c.companyTier, c.score, c.scoreLabel, JSON.stringify(c.matchedKeywords)],
  );
}

export async function updateScores(rows: Array<{ id: string; score: number; scoreLabel: ScoreLabel; matchedKeywords: string[]; companyTier: CompanyTier; metros: Metro[] }>): Promise<void> {
  if (rows.length === 0) return;
  await withTxn(async (client) => {
    for (const r of rows) {
      await client.query('UPDATE internships SET score = $2, score_label = $3, matched_keywords = $4, company_tier = $5, metros = $6 WHERE id = $1',
        [r.id, r.score, r.scoreLabel, JSON.stringify(r.matchedKeywords), r.companyTier, JSON.stringify(r.metros)]);
    }
  });
}

export async function updateDescription(id: string, description: string): Promise<void> {
  await getPool().query('UPDATE internships SET description = $2 WHERE id = $1', [id, description]);
}

export async function getUnclassified(limit: number): Promise<Internship[]> {
  const { rows } = await getPool().query<Row>(
    'SELECT * FROM internships WHERE archived = false AND classified_at IS NULL ORDER BY seen_at DESC LIMIT $1', [limit],
  );
  return rows.map(fromRow);
}

// ---------------------------------------------------------------------------
// Link health
// ---------------------------------------------------------------------------

/** Record a completed link check; rows in `gone` also get failed_check_count set so rediscovery does not un-archive them. */
export async function markLinkChecked(ids: string[], gone: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getPool().query('UPDATE internships SET last_checked_at = now(), failed_check_count = CASE WHEN id = ANY($2::text[]) THEN 1 ELSE 0 END WHERE id = ANY($1::text[])', [ids, gone]);
}
