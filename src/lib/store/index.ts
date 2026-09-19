import type { PoolClient } from 'pg';
import { getPool } from '../db';
import type { Internship, StoredInternship } from '../types';
import type { RoleType, Degree, PostingClassification } from '../classify/posting';
import type { Salary } from '../salary';
import type { CompanyTier } from '../classify/company';
import { companyKey } from '../company-key';

export * from './companies';
import { getState, setState } from '../app-state';
import { present } from '../present';

// ---------------------------------------------------------------------------
// Row mapping. COLUMNS is the single description of how a StoredInternship
// maps to the internships table. Derived fields (score, metros) are never
// stored; present() computes them on read.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string | null;
  link: string;
  source: string;
  posted_at: Date | null;
  seen_at: Date;
  first_seen_at: Date;
  archived: boolean;
  failed_check_count: number;
  last_checked_at: Date | null;
  locations: string[] | null;
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_unit: Salary['unit'];
  normalized_key: string | null;
  job_key: string | null;
  company_key: string | null;
  season: string[] | null;
  role_type: RoleType | null;
  degrees: Degree[] | null;
  us_eligible: 'yes' | 'no' | 'unclear' | null;
  is_internship: boolean | null;
  classified_at: Date | null;
  /** Joined from company_profiles on read. */
  company_tier: CompanyTier | null;
}

const COLUMNS: ReadonlyArray<[keyof Row, (i: StoredInternship) => unknown]> = [
  ['id', i => i.id],
  ['title', i => i.title],
  ['company', i => i.company],
  ['location', i => i.location],
  ['description', i => i.description ?? null],
  ['link', i => i.link],
  ['source', i => i.source],
  ['posted_at', i => i.postedAt ?? null],
  ['seen_at', i => i.seenAt],
  ['first_seen_at', i => i.firstSeenAt],
  ['archived', i => i.archived],
  ['failed_check_count', i => i.failedCheckCount],
  ['last_checked_at', i => i.lastCheckedAt ?? null],
  ['locations', i => JSON.stringify(i.locations)],
  ['salary_text', i => i.salaryText ?? null],
  ['salary_min', i => i.salaryMin ?? null],
  ['salary_max', i => i.salaryMax ?? null],
  ['salary_unit', i => i.salaryUnit ?? null],
  ['normalized_key', i => i.normalizedKey],
  ['job_key', i => i.jobKey ?? null],
  ['company_key', i => companyKey(i.company)],
  ['season', i => JSON.stringify(i.season)],
  ['role_type', i => i.roleType ?? null],
  ['degrees', i => i.degrees ? JSON.stringify(i.degrees) : null],
  ['us_eligible', i => i.usEligible ?? null],
  ['is_internship', i => i.isInternship ?? null],
  ['classified_at', i => i.classifiedAt ?? null],
];

const COL_NAMES = COLUMNS.map(([c]) => c);
const INSERT_SQL = `INSERT INTO internships (${COL_NAMES.join(',')}) VALUES (${COL_NAMES.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`;

function toValues(i: StoredInternship): unknown[] {
  return COLUMNS.map(([, get]) => get(i));
}

const iso = (d: Date | null): string | undefined => d?.toISOString();

function fromRow(r: Row): StoredInternship {
  return {
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    description: r.description ?? undefined,
    link: r.link,
    source: r.source,
    postedAt: iso(r.posted_at),
    seenAt: r.seen_at.toISOString(),
    firstSeenAt: r.first_seen_at.toISOString(),
    archived: r.archived,
    failedCheckCount: r.failed_check_count,
    lastCheckedAt: iso(r.last_checked_at),
    locations: r.locations ?? (r.location ? [r.location] : []),
    salaryText: r.salary_text ?? undefined,
    salaryMin: r.salary_min ?? undefined,
    salaryMax: r.salary_max ?? undefined,
    salaryUnit: r.salary_unit ?? undefined,
    normalizedKey: r.normalized_key ?? '',
    jobKey: r.job_key ?? undefined,
    season: r.season ?? [],
    roleType: r.role_type ?? undefined,
    degrees: r.degrees ?? undefined,
    usEligible: r.us_eligible ?? undefined,
    isInternship: r.is_internship ?? undefined,
    classifiedAt: iso(r.classified_at),
    companyTier: r.company_tier ?? undefined,
  };
}

// Every read joins the company's judged tier; present() then applies curated overrides.
const SELECT = `SELECT i.*, p.tier AS company_tier FROM internships i LEFT JOIN company_profiles p ON p.company_key = i.company_key`;

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

/** Active rows (unless includeArchived), presented, sorted by score by default. */
export async function getInternships(filters: ListFilters = {}): Promise<Internship[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (!filters.includeArchived) where.push('i.archived = false');
  if (filters.sources && filters.sources.length > 0) {
    where.push(`LOWER(i.source) = ANY(${p(filters.sources.map(s => s.toLowerCase()))}::text[])`);
  } else if (filters.source) {
    where.push(`LOWER(i.source) = ${p(filters.source.toLowerCase())}`);
  }
  if (filters.search) {
    const q = p(`%${filters.search.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(LOWER(i.title) LIKE ${q} ESCAPE '\\' OR LOWER(i.company) LIKE ${q} ESCAPE '\\' OR LOWER(i.location) LIKE ${q} ESCAPE '\\')`);
  }

  const { rows } = await getPool().query<Row>(`${SELECT}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`, params);
  const now = new Date();
  let out = rows.map(r => present(fromRow(r), now));
  if (filters.minScore !== undefined) out = out.filter(i => i.score >= filters.minScore!);
  if (filters.label) out = out.filter(i => i.scoreLabel.toLowerCase() === filters.label!.toLowerCase());
  const at = (i: Internship) => new Date(i.postedAt ?? i.firstSeenAt).getTime();
  out.sort(filters.sort === 'newest' ? (a, b) => b.seenAt.localeCompare(a.seenAt)
    : filters.sort === 'posted' ? (a, b) => at(b) - at(a)
    : (a, b) => b.score - a.score);
  return out;
}

export async function getInternship(id: string): Promise<Internship | null> {
  const { rows } = await getPool().query<Row>(`${SELECT} WHERE i.id = $1`, [id]);
  return rows[0] ? present(fromRow(rows[0])) : null;
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
}

const EMPTY_POLL_STATS: PollStats = { polledAt: '', sourceCounts: {}, netNewBySource: {} };

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
  });
}

export async function getStats(): Promise<{
  total: number;
  bySource: Record<string, number>;
  byLabel: Record<string, number>;
  lastPolledAt: string | null;
  lastCycleSourceCounts: Record<string, number>;
  lastCycleNetNewBySource: Record<string, number>;
}> {
  const pool = getPool();
  const [bySourceR, lastSeenR, poll, active] = await Promise.all([
    pool.query<{ source: string; n: string }>('SELECT source, COUNT(*)::text AS n FROM internships WHERE archived = false GROUP BY source'),
    pool.query<{ seen_at: Date }>('SELECT MAX(seen_at) AS seen_at FROM internships'),
    getPollStats(),
    getInternships(),
  ]);
  const bySource: Record<string, number> = {};
  for (const r of bySourceR.rows) bySource[r.source] = +r.n;
  const byLabel: Record<string, number> = {};
  for (const i of active) byLabel[i.scoreLabel] = (byLabel[i.scoreLabel] ?? 0) + 1;
  return {
    total: Object.values(bySource).reduce((a, b) => a + b, 0),
    bySource,
    byLabel,
    lastPolledAt: lastSeenR.rows[0]?.seen_at?.toISOString() ?? null,
    lastCycleSourceCounts: poll.sourceCounts,
    lastCycleNetNewBySource: poll.netNewBySource,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface StoreResult {
  newInternships: StoredInternship[];
  totalStored: number;
  netNewBySource: Record<string, number>;
}

// Rediscovery of a stored row (same id, or same company+title via another
// source). Bumps seen_at and backfills fields that were null. A row archived because no poller had seen it comes
// back; one rejected by the classifier, the season rule, or a dead-link check
// stays archived. The stored link is preserved.
const BACKFILL_SQL = `
  UPDATE internships SET
    seen_at          = $1,
    archived         = CASE WHEN failed_check_count > 0 OR (archive_reason IS NOT NULL AND archive_reason <> 'not seen') THEN archived ELSE false END,
    archive_reason   = CASE WHEN failed_check_count > 0 OR (archive_reason IS NOT NULL AND archive_reason <> 'not seen') THEN archive_reason ELSE NULL END,
    description      = COALESCE(NULLIF(description, ''), $2),
    salary_text      = COALESCE(salary_text, $3),
    salary_min       = COALESCE(salary_min,  $4),
    salary_max       = COALESCE(salary_max,  $5),
    salary_unit      = COALESCE(salary_unit, $6),
    locations        = $7,
    location         = $8,
    normalized_key   = COALESCE(normalized_key, $9),
    posted_at        = COALESCE(posted_at, $11)
  WHERE id = $10`;

function backfillArgs(i: StoredInternship, targetId: string): unknown[] {
  return [
    i.seenAt, i.description ?? null, i.salaryText ?? null, i.salaryMin ?? null, i.salaryMax ?? null, i.salaryUnit ?? null,
    JSON.stringify(i.locations), i.location, i.normalizedKey, targetId, i.postedAt ?? null,
  ];
}

/**
 * Insert never-seen postings and refresh rediscovered ones. Dedup keys, in
 * order: id (md5 of company+title+link), exact link, normalizedKey
 * (company + normalized title, catches the same role from another source).
 * When a stored simplify.jobs wrapper link is rediscovered with a direct ATS
 * URL, the stored link is upgraded.
 */
export async function deduplicateAndStore(incoming: StoredInternship[]): Promise<StoreResult> {
  return withLock(() => withTxn(async (client) => {
    const existing = (await client.query<{ id: string; link: string; normalized_key: string | null; job_key: string | null }>(
      'SELECT id, link, normalized_key, job_key FROM internships WHERE archived = false',
    )).rows;
    const rowByJob = new Map<string, string>();
    for (const r of existing) if (r.job_key) rowByJob.set(r.job_key, r.id);
    const rowByKey = new Map<string, { id: string; link: string }>();
    for (const r of existing) if (r.normalized_key) rowByKey.set(r.normalized_key, { id: r.id, link: r.link });

    const newInternships: StoredInternship[] = [];
    const netNewBySource: Record<string, number> = {};

    for (const i of incoming) {
      const byId = await client.query('SELECT 1 FROM internships WHERE id = $1', [i.id]);
      if (byId.rowCount) {
        await client.query(BACKFILL_SQL, backfillArgs(i, i.id));
        continue;
      }
      const key = i.jobKey;
      const sameJob = key ? rowByJob.get(key) : undefined;
      if (sameJob) {
        await client.query(BACKFILL_SQL, backfillArgs(i, sameJob));
        continue;
      }

      const sameRole = rowByKey.get(i.normalizedKey);
      if (sameRole) {
        await client.query(BACKFILL_SQL, backfillArgs(i, sameRole.id));
        if (sameRole.link.includes('simplify.jobs') && !i.link.includes('simplify.jobs')) {
          await client.query('UPDATE internships SET link = $2 WHERE id = $1', [sameRole.id, i.link]);
          rowByKey.set(i.normalizedKey, { id: sameRole.id, link: i.link });
        }
        if (key) rowByJob.set(key, sameRole.id);
        continue;
      }

      await client.query(INSERT_SQL, toValues(i));
      if (key) rowByJob.set(key, i.id);
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
// Posting classification and enrichment
// ---------------------------------------------------------------------------

export async function saveClassification(id: string, c: PostingClassification): Promise<void> {
  await getPool().query(
    'UPDATE internships SET role_type = $2, degrees = $3, us_eligible = $4, is_internship = $5, classified_at = now() WHERE id = $1',
    [id, c.roleType, JSON.stringify(c.degrees), c.usEligible, c.isInternship],
  );
}

export async function updateDescription(id: string, description: string): Promise<void> {
  await getPool().query('UPDATE internships SET description = $2 WHERE id = $1', [id, description]);
}

export async function updateLocations(id: string, locations: string[]): Promise<void> {
  await getPool().query('UPDATE internships SET locations = $2, location = $3 WHERE id = $1', [id, JSON.stringify(locations), locations[0] ?? '']);
}

export async function getUnclassified(limit: number): Promise<Internship[]> {
  const { rows } = await getPool().query<Row>(`${SELECT} WHERE i.archived = false AND i.classified_at IS NULL ORDER BY i.seen_at DESC LIMIT $1`, [limit]);
  return rows.map(r => present(fromRow(r)));
}

// ---------------------------------------------------------------------------
// Link health
// ---------------------------------------------------------------------------

/** Record a completed link check; rows in `gone` also get failed_check_count set so rediscovery does not un-archive them. */
export async function markLinkChecked(ids: string[], gone: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getPool().query('UPDATE internships SET last_checked_at = now(), failed_check_count = CASE WHEN id = ANY($2::text[]) THEN 1 ELSE 0 END WHERE id = ANY($1::text[])', [ids, gone]);
}
