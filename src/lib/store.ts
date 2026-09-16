import type { PoolClient } from 'pg';
import { getPool } from './db';
import type { Internship, ScoreLabel } from './types';
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
  applied: boolean;
  archived: boolean;
  applied_at: Date | null;
  failed_check_count: number;
  first_failed_at: Date | null;
  last_checked_at: Date | null;
  multi_location: string[] | null;
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_unit: Salary['unit'];
  normalized_key: string | null;
  hidden: boolean;
  season: string[] | null;
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
  ['applied', i => i.applied],
  ['archived', i => i.archived],
  ['applied_at', i => i.appliedAt ?? null],
  ['failed_check_count', i => i.failedCheckCount],
  ['first_failed_at', i => i.firstFailedAt ?? null],
  ['last_checked_at', i => i.lastCheckedAt ?? null],
  ['multi_location', i => i.multiLocation ? JSON.stringify(i.multiLocation) : null],
  ['salary_text', i => i.salaryText ?? null],
  ['salary_min', i => i.salaryMin ?? null],
  ['salary_max', i => i.salaryMax ?? null],
  ['salary_unit', i => i.salaryUnit ?? null],
  ['normalized_key', i => i.normalizedKey],
  ['hidden', i => i.hidden],
  ['season', i => JSON.stringify(i.season)],
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
    applied: r.applied,
    appliedAt: iso(r.applied_at),
    hidden: r.hidden,
    archived: r.archived,
    failedCheckCount: r.failed_check_count,
    firstFailedAt: iso(r.first_failed_at),
    lastCheckedAt: iso(r.last_checked_at),
    multiLocation: r.multi_location ?? undefined,
    salaryText: r.salary_text ?? undefined,
    salaryMin: r.salary_min ?? undefined,
    salaryMax: r.salary_max ?? undefined,
    salaryUnit: r.salary_unit ?? undefined,
    normalizedKey: r.normalized_key ?? '',
    season: r.season ?? [],
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
  includeHidden?: boolean;
  sort?: 'newest' | 'posted' | 'score';
  search?: string;
}

export async function getInternships(filters: ListFilters = {}): Promise<Internship[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (!filters.includeArchived) where.push('archived = false');
  if (!filters.includeHidden) where.push('hidden = false');
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
// source). Bumps seen_at, un-archives unless link checks failed, re-scores
// with the current config, and backfills fields that were null. User state
// (applied, hidden, applied_at) and the stored link are preserved.
const BACKFILL_SQL = `
  UPDATE internships SET
    seen_at          = $1,
    archived         = CASE WHEN failed_check_count > 0 THEN archived ELSE false END,
    score            = $2,
    score_label      = $3,
    matched_keywords = $4,
    description      = COALESCE(NULLIF(description, ''), $5),
    salary_text      = COALESCE(salary_text, $6),
    salary_min       = COALESCE(salary_min,  $7),
    salary_max       = COALESCE(salary_max,  $8),
    salary_unit      = COALESCE(salary_unit, $9),
    multi_location   = COALESCE(multi_location, $10),
    normalized_key   = COALESCE(normalized_key, $11)
  WHERE id = $12`;

function backfillArgs(i: Internship, targetId: string): unknown[] {
  return [
    i.seenAt, i.score, i.scoreLabel, JSON.stringify(i.matchedKeywords),
    i.description ?? null, i.salaryText ?? null, i.salaryMin ?? null, i.salaryMax ?? null, i.salaryUnit ?? null,
    i.multiLocation ? JSON.stringify(i.multiLocation) : null, i.normalizedKey, targetId,
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

/** null clears a nullable column; undefined leaves it untouched. */
export type InternshipPatch = Partial<Pick<Internship, 'applied' | 'hidden' | 'link'>> & { appliedAt?: string | null };

const PATCH_COLUMNS: Record<keyof InternshipPatch, string> = {
  applied: 'applied',
  appliedAt: 'applied_at',
  hidden: 'hidden',
  link: 'link',
};

export async function patchInternship(id: string, patch: InternshipPatch): Promise<Internship | null> {
  const entries = (Object.keys(patch) as Array<keyof InternshipPatch>).filter(k => patch[k] !== undefined);
  if (entries.length === 0) return getInternship(id);
  const sets = entries.map((k, idx) => `${PATCH_COLUMNS[k]} = $${idx + 2}`);
  const { rows } = await getPool().query<Row>(
    `UPDATE internships SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...entries.map(k => patch[k] ?? null)],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function archiveInternshipsByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await getPool().query('UPDATE internships SET archived = true WHERE id = ANY($1::text[])', [ids]);
  return result.rowCount ?? 0;
}

export async function deleteInternship(id: string): Promise<void> {
  await getPool().query('DELETE FROM internships WHERE id = $1', [id]);
}

// ---------------------------------------------------------------------------
// Link revalidation
// ---------------------------------------------------------------------------

const AGGREGATOR_DOMAINS = new Set([
  'trabajo.org', 'recruit.net', 'jooble.org', 'jooble.com',
  'indeed.co.uk', 'indeed.com.my', 'glassdoor.com.au',
  'simplyhired.com', 'ziprecruiter.com', 'careerbliss.com',
  'casalesadvantage.com', 'tarta.ai', 'talent.com', 'jobylon.com',
  'jobrapido.com', 'jobsite.co.uk', 'cvlibrary.co.uk', 'totaljobs.com',
  'monster.com', 'dice.com', 'careerbuilder.com', 'hotjobs.com',
  'beyond.com', 'employmentguide.com', 'jobs2careers.com', 'neuvoo.com',
  'careerjet.com', 'instahyre.com', 'workopolis.com', 'elut.ca',
  'trovit.com', 'kariera.gr', 'jobbol.com',
  'jobleads.com', 'learn4good.com',
  'talent.apple.com', 'jobs.disneycareers.com',
]);

function isAggregatorLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const agg of AGGREGATOR_DOMAINS) if (host === agg || host.endsWith('.' + agg)) return true;
    return false;
  } catch {
    return true;
  }
}

/** HTTP status of a HEAD request (GET on HEAD error); -1 on network error or timeout. */
export async function checkLinkStatus(url: string, timeoutMs = 3000): Promise<number> {
  const attempt = async (method: 'HEAD' | 'GET'): Promise<number> => {
    const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    return res.status;
  };
  try {
    return await attempt('HEAD');
  } catch {
    return attempt('GET').catch(() => -1);
  }
}

// Statuses that mean the posting is gone. 403/429/5xx are transient.
const GONE = new Set([401, 404, 410, 451]);

export async function revalidateLinks(): Promise<{ checked: number; archived: number; errors: number }> {
  const now = new Date().toISOString();
  const active = await getInternships();
  console.log(`[revalidate] ${active.length} active rows to check`);

  const updates: Internship[] = [];
  let archived = 0;
  let errors = 0;

  const BATCH = 20;
  for (let i = 0; i < active.length; i += BATCH) {
    await Promise.all(active.slice(i, i + BATCH).map(async (entry) => {
      const status = isAggregatorLink(entry.link) ? 404 : await checkLinkStatus(entry.link);
      entry.lastCheckedAt = now;
      if (GONE.has(status)) {
        entry.archived = true;
        entry.failedCheckCount += 1;
        entry.firstFailedAt ??= now;
        archived++;
      } else if (status === -1) {
        errors++;
      } else if (status < 400 && entry.failedCheckCount > 0) {
        entry.failedCheckCount = 0;
        entry.firstFailedAt = undefined;
      }
      updates.push(entry);
    }));
  }

  await withTxn(async (client) => {
    for (const r of updates) {
      await client.query(
        'UPDATE internships SET archived = $1, failed_check_count = $2, first_failed_at = $3, last_checked_at = $4 WHERE id = $5',
        [r.archived, r.failedCheckCount, r.firstFailedAt ?? null, r.lastCheckedAt, r.id],
      );
    }
  });

  console.log(`[revalidate] checked=${active.length} archived=${archived} errors=${errors}`);
  return { checked: active.length, archived, errors };
}
