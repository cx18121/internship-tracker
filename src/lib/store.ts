import * as fs from 'fs';
import * as path from 'path';
import type { PoolClient } from 'pg';
import { getPool, closePool } from './db';
import { Internship } from './types';
import { stripUtm } from './utils/normalize';
import { deriveSeasonWithDefault } from './seasons';

// ---------------------------------------------------------------------------
// Paths (only for JSON sidecar files — poll-stats.json. DB lives in Postgres.)
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');

// ---------------------------------------------------------------------------
// Aggregator domains (link-utility, doesn't touch storage)
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

export function isAggregatorLink(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    const lower = hostname.toLowerCase().replace(/^www\./, '');
    for (const agg of AGGREGATOR_DOMAINS) {
      if (lower === agg || lower.endsWith('.' + agg)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export async function checkLinkStatus(url: string, timeoutMs = 3000): Promise<number> {
  try {
    const http = await import('http');
    const https = await import('https');
    return await new Promise((resolve) => {
      const isHttps = url.startsWith('https://');
      const mod = isHttps ? https : http;
      const req = mod.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
        resolve(res.statusCode ?? -1);
      });
      req.on('error', () => {
        const getReq = mod.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
          resolve(res.statusCode ?? -1);
        });
        getReq.on('error', () => resolve(-1));
        getReq.on('timeout', () => { getReq.destroy(); resolve(-1); });
        getReq.end();
      });
      req.on('timeout', () => { req.destroy(); resolve(-1); });
      req.end();
    });
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Pool lifecycle. closeDb retained as an alias for graceful-shutdown callers.
// ---------------------------------------------------------------------------

export async function closeDb(): Promise<void> {
  await closePool();
}

// ---------------------------------------------------------------------------
// Row ↔ Internship mappers
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string | null;
  link: string;
  source: string;
  ats_source: string | null;
  ats_job_id: string | null;
  ats_target: string | null;
  posted_at: Date;
  seen_at: Date;
  score: number | null;
  score_label: string | null;
  matched_keywords: unknown;          // JSONB → parsed by pg
  is_new: boolean;
  applied: boolean;
  archived: boolean;
  applied_at: Date | null;
  application_url: string | null;
  application_status: string | null;
  failed_check_count: number;
  first_failed_at: Date | null;
  last_checked_at: Date | null;
  multi_location: unknown;            // JSONB
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_unit: string | null;
  normalized_key: string | null;
  hidden: boolean;
  season: unknown;                    // JSONB
}

// Pg returns timestamps as Date. Surface them to consumers as ISO strings to
// match the existing Internship type contract.
function dateToIso(d: Date | null): string | undefined {
  return d ? d.toISOString() : undefined;
}

function fromRow(r: Row): Internship {
  return {
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    description: r.description ?? undefined,
    link: r.link,
    source: r.source,
    atsSource: r.ats_source ?? undefined,
    atsJobId: r.ats_job_id ?? undefined,
    atsTarget: r.ats_target ?? undefined,
    postedAt: r.posted_at.toISOString(),
    seenAt: r.seen_at.toISOString(),
    score: r.score,
    // Same scoreLabel contract as before: NULL in DB surfaces as '' so the
    // type stays `string` for legacy callers; byLabel stats still see NULL.
    scoreLabel: r.score_label ?? '',
    matchedKeywords: (Array.isArray(r.matched_keywords) ? r.matched_keywords : []) as string[],
    isNew: r.is_new,
    applied: r.applied,
    archived: r.archived,
    appliedAt: dateToIso(r.applied_at),
    applicationUrl: r.application_url ?? undefined,
    applicationStatus: r.application_status ?? undefined,
    failedCheckCount: r.failed_check_count,
    firstFailedAt: dateToIso(r.first_failed_at),
    lastCheckedAt: dateToIso(r.last_checked_at),
    multiLocation: Array.isArray(r.multi_location) ? (r.multi_location as string[]) : undefined,
    salaryText: r.salary_text ?? undefined,
    salaryMin: r.salary_min ?? undefined,
    salaryMax: r.salary_max ?? undefined,
    salaryUnit: (r.salary_unit as Internship['salaryUnit']) ?? undefined,
    normalizedKey: r.normalized_key ?? undefined,
    hidden: r.hidden,
    season: Array.isArray(r.season) ? (r.season as string[]) : undefined,
  };
}

// Build the ordered list of values passed to INSERT/UPDATE statements. Mirrors
// COL_NAMES below; keep them in lockstep.
const COL_NAMES = [
  'id', 'title', 'company', 'location', 'description', 'link', 'source',
  'ats_source', 'ats_job_id', 'ats_target', 'posted_at', 'seen_at',
  'score', 'score_label', 'matched_keywords', 'is_new', 'applied',
  'archived', 'applied_at', 'application_url', 'application_status',
  'failed_check_count', 'first_failed_at', 'last_checked_at',
  'multi_location', 'salary_text', 'salary_min', 'salary_max', 'salary_unit',
  'normalized_key', 'hidden', 'season',
] as const;

function toValues(i: Internship): unknown[] {
  return [
    i.id,
    i.title,
    i.company,
    i.location,
    i.description ?? null,
    i.link,
    i.source,
    i.atsSource ?? null,
    i.atsJobId ?? null,
    i.atsTarget ?? null,
    i.postedAt,
    i.seenAt,
    i.score ?? null,
    // Persist NULL for empty/missing labels so the DB column reflects truth
    // (never scored) instead of an empty string.
    i.scoreLabel ? i.scoreLabel : null,
    // Pass arrays/objects directly to JSONB — pg serializes via its types layer.
    JSON.stringify(i.matchedKeywords ?? []),
    // Boolean columns are NOT NULL — coerce undefined → false so callers that
    // omit these flags (most don't carry `archived`) don't blow up the insert.
    i.isNew ?? true,
    i.applied ?? false,
    i.archived ?? false,
    i.appliedAt ?? null,
    i.applicationUrl ?? null,
    i.applicationStatus ?? null,
    i.failedCheckCount ?? 0,
    i.firstFailedAt ?? null,
    i.lastCheckedAt ?? null,
    i.multiLocation ? JSON.stringify(i.multiLocation) : null,
    i.salaryText ?? null,
    i.salaryMin ?? null,
    i.salaryMax ?? null,
    i.salaryUnit ?? null,
    i.normalizedKey ?? null,
    i.hidden ?? false,
    // Auto-populate from title on every write so the column stays in sync with
    // the title. Callers can override by setting i.season explicitly.
    JSON.stringify(i.season ?? deriveSeasonWithDefault(i.title)),
  ];
}

// ---------------------------------------------------------------------------
// In-process mutex (prevents concurrent dedup races within one process)
// ---------------------------------------------------------------------------

let storeLock: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = storeLock.then(() => fn() as Promise<T>);
  storeLock = next.then(() => {}, (err) => { console.error('[store] lock error:', err); });
  return next;
}

// Acquire a pooled client, run the transactional work, COMMIT or ROLLBACK on
// error. Used by dedup + revalidation paths that need atomic multi-statement
// writes.
async function withTxn<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Public storage API
// ---------------------------------------------------------------------------

export async function loadInternships(): Promise<Internship[]> {
  const { rows } = await getPool().query<Row>('SELECT * FROM internships ORDER BY seen_at DESC');
  return rows.map(fromRow);
}

const UPSERT_SQL = (() => {
  const placeholders = COL_NAMES.map((_, i) => `$${i + 1}`).join(',');
  const updateAssignments = COL_NAMES
    .filter((c) => c !== 'id')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  return `
    INSERT INTO internships (${COL_NAMES.join(',')})
    VALUES (${placeholders})
    ON CONFLICT (id) DO UPDATE SET ${updateAssignments}
  `;
})();

/**
 * Full-replace write — kept for callers that still expect array semantics.
 * Slower than targeted updates; prefer `patchInternship` / `archiveStalePostings`
 * / `deduplicateAndStore` for hot paths.
 */
export async function saveInternships(internships: Internship[]): Promise<void> {
  if (internships.length === 0) return;
  await withTxn(async (client) => {
    for (const r of internships) {
      await client.query(UPSERT_SQL, toValues(r));
    }
  });
}

export interface StoreResult {
  newInternships: Internship[];
  totalStored: number;
  incomingBySource: Record<string, number>;
  netNewBySource: Record<string, number>;
}

export async function deduplicateAndStore(incoming: Internship[]): Promise<StoreResult> {
  return withLock(async () => {
    // Build seenLinks + seenKeys sets from existing active rows for cross-source
    // dedup. Also index by normalized_key so the dedup loop can upgrade a
    // stored row's link when a later source finds the same role via a direct
    // apply URL (SimplifyJobs frequently falls back to simplify.jobs wrappers).
    const pool = getPool();
    const seenLinkRows = (await pool.query<{ id: string; link: string; normalized_key: string | null }>(
      'SELECT id, link, normalized_key FROM internships WHERE archived = false'
    )).rows;
    const seenLinks = new Set<string>();
    const seenKeys = new Set<string>();
    const rowByKey = new Map<string, { id: string; link: string }>();
    for (const row of seenLinkRows) {
      if (row.link) seenLinks.add(stripUtm(row.link));
      if (row.normalized_key) {
        seenKeys.add(row.normalized_key);
        rowByKey.set(row.normalized_key, { id: row.id, link: row.link });
      }
    }

    const newInternships: Internship[] = [];
    const incomingBySource: Record<string, number> = {};
    const netNewBySource: Record<string, number> = {};

    for (const i of incoming) {
      const src = i.source || 'Unknown';
      incomingBySource[src] = (incomingBySource[src] || 0) + 1;
    }

    // Use a single transaction with one held client for the full batch.
    const totalStored = await withTxn(async (client) => {
      const existingIdRow = 'SELECT id FROM seen_ids WHERE id = $1';
      const insertSeen = 'INSERT INTO seen_ids (id) VALUES ($1) ON CONFLICT DO NOTHING';
      const upgradeLink = 'UPDATE internships SET link = $2 WHERE id = $1';

      // Cross-source backfill: when a different source rediscovers the same
      // role (matched by normalized_key), the incoming row may carry data the
      // stored row lacks — most commonly a description (SimplifyJobs ships
      // title-only, Workday/Greenhouse/Ashby ship the full posting). Without
      // this path the second source's richer payload is dropped on the floor.
      // COALESCE backfills missing fields only; score/keywords always replace
      // because the new score was computed against richer data. seen_at bumps
      // (positive proof of life across sources) and archived flips off unless
      // the row was failing link checks. Source attribution and user state
      // (applied/hidden/applied_at/application_url/application_status) and the
      // stored link/title/company are preserved.
      const crossSourceBackfill = `
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
          ats_source       = COALESCE(ats_source,  $10),
          ats_target       = COALESCE(ats_target,  $11),
          ats_job_id       = COALESCE(ats_job_id,  $12),
          multi_location   = COALESCE(multi_location, $13),
          normalized_key   = COALESCE(normalized_key, $14)
        WHERE id = $15
      `;

      // Refresh-on-rediscovery: same posting (same md5 ID) returns from a
      // later poll. Mark it as actively listed again — bump seen_at, un-archive
      // (rediscovery is positive proof the role is still live), re-score with
      // current config, and backfill description/salary/ATS fields if they
      // were null. User state (applied / hidden / applied_at / application_url
      // / application_status) is preserved.
      //
      // The stored `link` is intentionally NOT overwritten: the row's id is
      // md5(company + title + stripUtm(link)), so by construction a refresh
      // means the *original* link was identical. Meanwhile other writers
      // (find-ats-links-daily.ts) upgrade the stored link to a direct ATS URL;
      // overwriting on every poll would clobber that upgrade.
      const refreshOnRediscovery = crossSourceBackfill; // identical column list

      // Insert-if-absent for first-time discoveries.
      const insertInternship = (() => {
        const placeholders = COL_NAMES.map((_, i) => `$${i + 1}`).join(',');
        return `INSERT INTO internships (${COL_NAMES.join(',')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`;
      })();

      for (const i of incoming) {
        // Exact id seen? Refresh the existing row instead of silently
        // dropping — bumps seen_at so revalidation/source-health reflects
        // current activity, un-archives if it was archived (rediscovery =
        // still posted), and backfills description/salary/ATS provenance.
        // Preserves user state.
        const seen = await client.query(existingIdRow, [i.id]);
        if (seen.rowCount && seen.rowCount > 0) {
          const refreshed = { ...i, link: stripUtm(i.link || '') || i.link };
          await client.query(refreshOnRediscovery, [
            refreshed.seenAt,
            refreshed.score ?? null,
            refreshed.scoreLabel ? refreshed.scoreLabel : null,
            JSON.stringify(refreshed.matchedKeywords ?? []),
            refreshed.description ?? null,
            refreshed.salaryText ?? null,
            refreshed.salaryMin ?? null,
            refreshed.salaryMax ?? null,
            refreshed.salaryUnit ?? null,
            refreshed.atsSource ?? null,
            refreshed.atsTarget ?? null,
            refreshed.atsJobId ?? null,
            refreshed.multiLocation ? JSON.stringify(refreshed.multiLocation) : null,
            refreshed.normalizedKey ?? null,
            i.id,
          ]);
          continue;
        }

        // Same posting via different UTM params?
        const normalizedLink = stripUtm(i.link || '');
        if (i.link && seenLinks.has(normalizedLink)) continue;

        // Same role posted by another source (normalized company + title)?
        if (i.normalizedKey && seenKeys.has(i.normalizedKey)) {
          const existing = rowByKey.get(i.normalizedKey);
          if (existing) {
            const backfilled = { ...i, id: existing.id, link: stripUtm(i.link || '') || i.link };
            await client.query(crossSourceBackfill, [
              backfilled.seenAt,
              backfilled.score ?? null,
              backfilled.scoreLabel ? backfilled.scoreLabel : null,
              JSON.stringify(backfilled.matchedKeywords ?? []),
              backfilled.description ?? null,
              backfilled.salaryText ?? null,
              backfilled.salaryMin ?? null,
              backfilled.salaryMax ?? null,
              backfilled.salaryUnit ?? null,
              backfilled.atsSource ?? null,
              backfilled.atsTarget ?? null,
              backfilled.atsJobId ?? null,
              backfilled.multiLocation ? JSON.stringify(backfilled.multiLocation) : null,
              backfilled.normalizedKey ?? null,
              existing.id,
            ]);
            // If the stored row's link is a simplify.jobs wrapper and the
            // incoming row has a direct apply URL, upgrade the stored link in
            // place. Source attribution (first-discoverer) is preserved.
            if (
              existing.link.includes('simplify.jobs') &&
              normalizedLink &&
              !normalizedLink.includes('simplify.jobs')
            ) {
              await client.query(upgradeLink, [existing.id, normalizedLink]);
              rowByKey.set(i.normalizedKey, { id: existing.id, link: normalizedLink });
              seenLinks.add(normalizedLink);
            }
          }
          continue;
        }

        if (i.link) seenLinks.add(normalizedLink);
        if (i.normalizedKey) seenKeys.add(i.normalizedKey);

        const stored: Internship = { ...i, link: normalizedLink || i.link, isNew: true };
        await client.query(insertInternship, toValues(stored));
        await client.query(insertSeen, [stored.id]);
        newInternships.push(stored);
        // Track this row so a later item in the same batch can upgrade its
        // link if a direct apply URL turns up after a simplify.jobs one.
        if (stored.normalizedKey && stored.link) {
          rowByKey.set(stored.normalizedKey, { id: stored.id, link: stored.link });
        }
        const src = stored.source || 'Unknown';
        netNewBySource[src] = (netNewBySource[src] || 0) + 1;
      }

      const count = await client.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM internships');
      return parseInt(count.rows[0].n, 10);
    });

    return { newInternships, totalStored, incomingBySource, netNewBySource };
  });
}

export async function patchInternship(id: string, patch: Partial<Internship>): Promise<Internship | null> {
  // Wrap read→merge→write in the same withLock the poll cycle uses so
  // concurrent PATCH requests don't read-modify-write over each other. Without
  // this, two rapid PATCHes (e.g. user clicks "applied" then "hidden" before
  // the first request lands) both read the same baseline row, each merges its
  // own change, and the second write loses the first's change.
  return withLock(async () => {
    const { rows } = await getPool().query<Row>('SELECT * FROM internships WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    const merged: Internship = { ...fromRow(rows[0]), ...patch };
    await saveInternships([merged]);
    return merged;
  });
}

/**
 * Mark the given ids as archived. Narrow per-id UPDATE inside withLock so
 * callers that hold a stale in-memory snapshot for minutes (e.g. portal
 * scanner doing slow ATS fetches) don't clobber concurrent PATCHes by
 * upserting every column on every row they looked at.
 */
export async function archiveInternshipsByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return withLock(async () => {
    const result = await getPool().query(
      'UPDATE internships SET archived = true WHERE id = ANY($1::text[])',
      [ids],
    );
    return result.rowCount ?? 0;
  });
}

export async function archiveStalePostings(daysOld = 30): Promise<number> {
  // Serialize against the poll-cycle transaction in deduplicateAndStore so two
  // large writers don't race on the same rows.
  return withLock(async () => {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const result = await getPool().query(
      'UPDATE internships SET archived = true WHERE archived = false AND seen_at < $1',
      [cutoff],
    );
    const count = result.rowCount ?? 0;
    if (count > 0) {
      console.log(`[store] Archived ${count} stale postings older than ${daysOld} days`);
    }
    return count;
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
  const [totalR, bySourceR, byLabelR, lastSeenR] = await Promise.all([
    pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM internships'),
    pool.query<{ source: string; n: string }>('SELECT source, COUNT(*)::text AS n FROM internships GROUP BY source'),
    pool.query<{ score_label: string | null; n: string }>('SELECT score_label, COUNT(*)::text AS n FROM internships GROUP BY score_label'),
    pool.query<{ seen_at: Date }>('SELECT seen_at FROM internships ORDER BY seen_at DESC LIMIT 1'),
  ]);
  const total = parseInt(totalR.rows[0].n, 10);
  const bySource: Record<string, number> = {};
  for (const r of bySourceR.rows) bySource[r.source] = parseInt(r.n, 10);
  const byLabel: Record<string, number> = {};
  // null = never scored (e.g. legacy JSON-migrated rows). Bucket separately so
  // stats can distinguish unscored rows from any future explicit blanks.
  for (const r of byLabelR.rows) {
    const key = r.score_label == null ? 'unscored' : r.score_label;
    byLabel[key] = (byLabel[key] ?? 0) + parseInt(r.n, 10);
  }
  const lastPolledAt = lastSeenR.rows[0]?.seen_at.toISOString() ?? null;

  let exclusionCounts: Record<string, number> = {};
  let lastCycleSourceCounts: Record<string, number> = {};
  let lastCycleNetNewBySource: Record<string, number> = {};
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'poll-stats.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    exclusionCounts = parsed.exclusionCounts ?? {};
    lastCycleSourceCounts = parsed.sourceCounts ?? {};
    lastCycleNetNewBySource = parsed.netNewBySource ?? {};
  } catch {}

  return { total, bySource, byLabel, lastPolledAt, exclusionCounts, lastCycleSourceCounts, lastCycleNetNewBySource };
}

/**
 * Persisted per-poll exclusion counts. Stays as a flat JSON file — it's tiny
 * latest-only state, no need to occupy a DB table.
 */
export function savePollStats(stats: {
  polledAt: string;
  sourceCounts?: Record<string, number>;
  netNewBySource?: Record<string, number>;
  exclusionCounts: Record<string, number>;
}): void {
  const statsPath = path.join(DATA_DIR, 'poll-stats.json');
  // Merge per-source counts with the previous cycle's so a partial cycle (e.g.
  // the fast tier polling only SimplifyJobs) doesn't wipe last-cycle stats for
  // the sources it didn't poll. Each source keeps its most-recent figures
  // from whichever cycle last touched it.
  let prev: { sourceCounts?: Record<string, number>; netNewBySource?: Record<string, number> } = {};
  try {
    prev = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
  } catch {}
  const sourceCounts = { ...(prev.sourceCounts ?? {}), ...(stats.sourceCounts ?? {}) };
  const netNewBySource = { ...(prev.netNewBySource ?? {}), ...(stats.netNewBySource ?? {}) };
  fs.writeFileSync(statsPath, JSON.stringify({
    polledAt: stats.polledAt,
    sourceCounts,
    netNewBySource,
    exclusionCounts: stats.exclusionCounts,
  }, null, 2));
}

export async function getInternships(filters?: {
  source?: string;
  sources?: string[];
  minScore?: number;
  label?: string;
  includeArchived?: boolean;
  includeHidden?: boolean;
  sort?: 'newest' | 'posted' | 'score';
  search?: string;
}): Promise<Internship[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = () => `$${params.length}`;

  if (!filters?.includeArchived) where.push('archived = false');
  if (!filters?.includeHidden) where.push('hidden = false');
  // Prefer multi-source `sources` over single `source` if both are provided.
  // The list route used to flatten multi → undefined when length > 1, which
  // silently returned everything; pass the array through here instead.
  if (filters?.sources && filters.sources.length > 0) {
    params.push(filters.sources.map((s) => s.toLowerCase()));
    where.push(`LOWER(source) = ANY(${p()}::text[])`);
  } else if (filters?.source) {
    params.push(filters.source.toLowerCase());
    where.push(`LOWER(source) = ${p()}`);
  }
  if (filters?.minScore !== undefined) {
    params.push(filters.minScore);
    where.push(`COALESCE(score, 0) >= ${p()}`);
  }
  if (filters?.label) {
    params.push(filters.label.toLowerCase());
    where.push(`LOWER(score_label) = ${p()}`);
  }
  if (filters?.search) {
    // Push the LIKE pattern once and reuse the same $N for all three columns —
    // pg accepts a placeholder repeated in a single statement.
    params.push(`%${filters.search.toLowerCase()}%`);
    const q = p();
    where.push(`(LOWER(title) LIKE ${q} OR LOWER(company) LIKE ${q} OR LOWER(location) LIKE ${q})`);
  }

  const orderBy = filters?.sort === 'newest'
    ? 'seen_at DESC'
    : filters?.sort === 'posted'
    ? 'posted_at DESC'
    : 'COALESCE(score, 0) DESC';

  const sql = `SELECT * FROM internships${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy}`;
  const { rows } = await getPool().query<Row>(sql, params);
  return rows.map(fromRow);
}

// ---------------------------------------------------------------------------
// Link revalidation (uses storage layer via patches)
// ---------------------------------------------------------------------------

export interface RevalidationResult {
  checked: number;
  stale: number;
  stillStale: number;
  recovered: number;
  archived: number;
  aggregatorFound: number;
  errors: number;
  kept: number;
}

async function processBatch<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

export async function revalidateLinks(opts: { dryRun?: boolean } = {}): Promise<RevalidationResult> {
  const now = new Date().toISOString();
  const BATCH_SIZE = 20;

  const { rows: activeRows } = await getPool().query<Row>(
    'SELECT * FROM internships WHERE archived = false AND hidden = false'
  );
  const active = activeRows.map(fromRow);
  console.log(`[revalidate] Starting${opts.dryRun ? ' (DRY RUN)' : ''}: ${active.length} entries to check in batches of ${BATCH_SIZE}`);

  const result: RevalidationResult = {
    checked: active.length,
    stale: 0, stillStale: 0, recovered: 0, archived: 0,
    aggregatorFound: 0, errors: 0, kept: 0,
  };

  const updates: Internship[] = [];

  // First pass: aggregator domains → archive immediately
  for (const entry of active) {
    if (isAggregatorLink(entry.link)) {
      entry.failedCheckCount = 2;
      entry.firstFailedAt = entry.firstFailedAt ?? now;
      entry.lastCheckedAt = now;
      if (!opts.dryRun) entry.archived = true;
      result.aggregatorFound++;
      updates.push(entry);
    }
  }

  const toHttpCheck = active.filter((e) => !e.archived && !isAggregatorLink(e.link));
  console.log(`[revalidate] ${toHttpCheck.length} need HTTP checks (${result.aggregatorFound} are aggregators)`);

  await processBatch(toHttpCheck, BATCH_SIZE, async (entry) => {
    let status: number;
    try {
      status = await checkLinkStatus(entry.link, 3000);
    } catch {
      status = -1;
    }
    entry.lastCheckedAt = now;

    // 401 = auth required (board moved private), 403 (some sites) too.
    // 410 / 451 = explicit gone. 404 = not found.
    // 429 / 5xx = transient (rate-limited or server hiccup).
    const PERMANENT = new Set([401, 404, 410, 451]);
    if (status >= 400 && PERMANENT.has(status)) {
      entry.failedCheckCount = 2;
      if (!opts.dryRun) entry.archived = true;
      result.archived++;
    } else if (status >= 400) {
      // Transient (403/429/5xx) — don't increment count
    } else if (status === -1) {
      result.errors++;
    } else if (entry.failedCheckCount !== undefined && entry.failedCheckCount > 0) {
      entry.failedCheckCount = 0;
      entry.firstFailedAt = undefined;
      result.recovered++;
      result.kept++;
    } else {
      result.kept++;
    }
    updates.push(entry);
    return entry;
  });

  if (!opts.dryRun && updates.length > 0) {
    // Narrow per-id UPDATE inside withLock instead of a full-row upsert.
    // revalidateLinks holds the in-memory `active` snapshot for the entire
    // HTTP-probe sweep (multiple minutes); a saveInternships(updates) at the
    // end would clobber any PATCH the UI / Discord buttons / daily ATS script
    // made during that window. We only mutate four columns here, so write
    // exactly those — leaves user/state columns alone for concurrent writers.
    await withLock(async () => {
      await withTxn(async (client) => {
        for (const r of updates) {
          await client.query(
            `UPDATE internships
               SET archived           = $1,
                   failed_check_count = $2,
                   first_failed_at    = $3,
                   last_checked_at    = $4
             WHERE id = $5`,
            [
              r.archived,
              r.failedCheckCount ?? 0,
              r.firstFailedAt ?? null,
              r.lastCheckedAt ?? null,
              r.id,
            ],
          );
        }
      });
    });
  }

  console.log(
    `[revalidate] checked=${result.checked} kept=${result.kept} ` +
    `archived=${result.archived} aggregatorFound=${result.aggregatorFound} ` +
    `errors=${result.errors} recovered=${result.recovered}${opts.dryRun ? ' [DRY RUN]' : ''}`
  );

  return result;
}

// Test-only helper: kept for compatibility with src/poller/test.ts
export async function _deleteInternshipForTest(id: string): Promise<void> {
  await getPool().query('DELETE FROM internships WHERE id = $1', [id]);
}
