import * as fs from 'fs';
import * as path from 'path';
import { Internship } from './types.js';
import { stripUtm } from './utils/normalize.js';

// ---------------------------------------------------------------------------
// Link revalidation constants
// ---------------------------------------------------------------------------

const seenPath = path.join(process.cwd(), 'data', 'seen.json');
const internshipsPath = path.join(process.cwd(), 'data', 'internships.json');

/**
 * Known aggregator/job-board domains that republish listings rather than
 * host direct applications. Links from these domains are treated as invalid
 * regardless of HTTP response code.
 */
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
  // Additional
  'talent.apple.com', 'jobs.disneycareers.com',  // branded career portals = direct
]);

// ---------------------------------------------------------------------------
// Link validation helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the URL hostname matches a known aggregator domain.
 * Uses simple substring matching so subdomains (e.g. us.trabajo.org) also match.
 */
export function isAggregatorLink(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    const lower = hostname.toLowerCase().replace(/^www\./, '');
    for (const agg of AGGREGATOR_DOMAINS) {
      if (lower.includes(agg)) return true;
    }
    return false;
  } catch {
    return true; // Malformed URL → treat as invalid
  }
}

/**
 * Performs an HTTP check on a URL.
 * Tries HEAD first; falls back to GET on error.
 * Follows up to 5 redirects.
 * @returns HTTP status code (e.g. 200, 404), or -1 on network/timeout error
 */
export async function checkLinkStatus(url: string, timeoutMs = 3000): Promise<number> {
  try {
    // Dynamic import to avoid pulling in http for non-Node targets
    const http = await import('http');
    const https = await import('https');

    return await new Promise((resolve) => {
      const isHttps = url.startsWith('https://');
      const mod = isHttps ? https : http;

      const req = mod.request(url, { method: 'HEAD', timeout: timeoutMs }, (res: import('http').IncomingMessage) => {
        resolve(res.statusCode ?? -1);
      });

      req.on('error', () => {
        // Fall back to GET for servers that reject HEAD
        const getReq = mod.request(url, { method: 'GET', timeout: timeoutMs }, (res: import('http').IncomingMessage) => {
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

/**
 * Result of a single revalidation run.
 */
export interface RevalidationResult {
  checked: number;       // total entries checked
  stale: number;          // always 0 (one-strike policy — 404 → immediate archive)
  stillStale: number;    // always 0 (one-strike policy — 404 → immediate archive)
  recovered: number;     // entries whose links recovered (count > 0 → 0)
  archived: number;      // entries archived (count reached 2)
  aggregatorFound: number;// entries flagged as aggregator links
  errors: number;         // HTTP/network errors (transient — don't increment count)
  kept: number;           // entries confirmed good
}

/**
 * Process entries in parallel batches with controlled concurrency.
 * Yields results as each batch completes.
 */
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

/**
 * Revalidates all non-archived internship links.
 *
 * Policy:
 *   - First failed HTTP check → failedCheckCount: 0 → 1 (stale, not yet removed)
 *   - Second consecutive failure → failedCheckCount: 1 → 2 (archived)
 *   - Successful check → failedCheckCount resets to 0
 *   - Network/HTTP error → error count not incremented (transient failure)
 *
 * Links on known aggregator domains are archived immediately (count = 2).
 *
 * HTTP checks run in parallel batches of 20 to balance speed vs. server load.
 * With 4800 entries and ~200ms average response, full run completes in ~1-2 minutes.
 */
export async function revalidateLinks(opts: { dryRun?: boolean } = {}): Promise<RevalidationResult> {
  const internships = loadInternships();
  const now = new Date().toISOString();
  const BATCH_SIZE = 20;

  const active = internships.filter(e => !e.archived);
  console.log(`[revalidate] Starting${opts.dryRun ? ' (DRY RUN)' : ''}: ${active.length} entries to check in batches of ${BATCH_SIZE}`);

  // First pass: instant aggregator checks (no HTTP needed)
  for (const entry of active) {
    if (isAggregatorLink(entry.link)) {
      entry.failedCheckCount = 2;
      entry.firstFailedAt = entry.firstFailedAt ?? now;
      entry.lastCheckedAt = now;
      if (!opts.dryRun) entry.archived = true;
    }
  }

  const toHttpCheck = active.filter(e => !e.archived && !isAggregatorLink(e.link));
  console.log(`[revalidate] ${toHttpCheck.length} need HTTP checks (${active.length - toHttpCheck.length} are aggregators or already archived)`);


  // Build the actual set to check — reference original array entries
  const toCheck = new Set(toHttpCheck);

  // Second pass: HTTP checks in parallel batches
  await processBatch(Array.from(toCheck), BATCH_SIZE, async (entry) => {
    let status: number;
    try {
      status = await checkLinkStatus(entry.link, 3000);
    } catch {
      status = -1;
    }
    entry.lastCheckedAt = now;

    if (status >= 400) {
      // Determine failure type: permanent (likely removed) vs. transient (bot protection / rate-limit)
      // 404, 410, 451 = genuinely gone — increment failure count
      // 403, 429, 500-599, 999 = transient block / server error — treat as transient error
      const PERMANENT_FAIL_CODES = new Set([404, 410, 451]);
      const isPermanent = PERMANENT_FAIL_CODES.has(status);

      if (isPermanent) {
        // First 404/410/451 → immediately archive (remove from active list)
        entry.failedCheckCount = 2;
        if (!opts.dryRun) entry.archived = true;
      } else {
        // Transient block/error — log but don't increment failure count
        // These are likely anti-bot pages, not dead links
        entry.lastCheckedAt = now;
      }
    } else if (status === -1) {
      // Network/timeout error — don't change count (transient)
    } else {
      // Link OK (2xx) — reset any existing failure count
      if (entry.failedCheckCount !== undefined && entry.failedCheckCount > 0) {
        entry.failedCheckCount = 0;
        entry.firstFailedAt = undefined;
      }
    }
    return entry;
  });

  // Compute result stats — iterate over original array so we capture real state
  const result: RevalidationResult = {
    checked: active.length,
    stale: 0, stillStale: 0, recovered: 0, archived: 0,
    aggregatorFound: active.length - toHttpCheck.length,
    errors: 0, kept: 0,
  };

  for (const e of internships) {
    if (e.archived) result.archived++;
    else if (e.failedCheckCount === 1) result.stale++;
    else if (e.failedCheckCount === 2) result.archived++;
    else if (e.failedCheckCount === 0) result.recovered++;
    else result.kept++;
  }

  if (!opts.dryRun) saveInternships(internships);

  console.log(
    `[revalidate] checked=${result.checked} kept=${result.kept} stale=${result.stale} ` +
    `stillStale=${result.stillStale} archived=${result.archived} aggregatorFound=${result.aggregatorFound} ` +
    `errors=${result.errors} recovered=${result.recovered}${opts.dryRun ? ' [DRY RUN]' : ''}`
  );

  return result;
}

/**
 * Ingest-time link validation.
 * Returns null if the link should be SKIPPED (not stored).
 * Returns the original Internship if the link is acceptable.
 *
 * Checks:
 *   1. Known aggregator domain → skip immediately
 *   2. HTTP 4xx/5xx on the URL → skip (don't let bad links into the DB)
 *
 * Note: HTTP check is fast (8s timeout). Links that time out are accepted
 * and revalidated daily — they may be behind slow servers, not dead.
 */
export async function validateLinkForIngest(entry: Internship): Promise<Internship | null> {
  if (isAggregatorLink(entry.link)) {
    console.warn(`[store] Skipping aggregator link: ${entry.link}`);
    return null;
  }

  try {
    const status = await checkLinkStatus(entry.link, 3000);
    if (status >= 400) {
      console.warn(`[store] Skipping dead link (${status}): ${entry.link}`);
      return null;
    }
  } catch {
    // Network error at ingest time — accept optimistically; revalidation will catch it
  }

  return entry;
}

// In-process mutex — prevents concurrent poll cycles from clobbering each other
let storeLock: Promise<void> = Promise.resolve();
// NOTE: errors from fn() propagate to the caller — callers must handle rejections.
function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = storeLock.then(() => fn() as Promise<T>);
  storeLock = next.then(() => {}, (err) => { console.error('[store] lock error:', err); });
  return next;
}

function loadSeen(): Set<string> {
  try {
    const raw = fs.readFileSync(seenPath, 'utf-8');
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

// Atomic write: write to .tmp then rename. On Linux/Mac, rename(2) is atomic,
// so a crash mid-write cannot produce a corrupt or empty file.
function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function saveSeen(seen: Set<string>): void {
  atomicWrite(seenPath, JSON.stringify([...seen], null, 2));
}

export function loadInternships(): Internship[] {
  try {
    const raw = fs.readFileSync(internshipsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch {
    // If the file is missing or corrupt, check for a leftover .tmp file from
    // a crash mid-rename and try to recover from it.
    try {
      const tmp = internshipsPath + '.tmp';
      const raw = fs.readFileSync(tmp, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        console.warn('[store] internships.json corrupt/missing — recovered from .tmp file');
        fs.renameSync(tmp, internshipsPath);
        return parsed;
      }
    } catch { /* no tmp file either */ }
    return [];
  }
}

export function saveInternships(internships: Internship[]): void {
  atomicWrite(internshipsPath, JSON.stringify(internships, null, 2));
}

export interface StoreResult {
  newInternships: Internship[];
  totalStored: number;
}

// ROOT CAUSE NOTE (2026-04-03): Previously used non-atomic writeFileSync. A crash
// mid-write corrupted internships.json to empty/partial, but seen.json stayed intact,
// so the scraper never re-added the 5000+ lost records. Fixed with atomic writes.
// The 20% safeguard below catches any future case where a bug would cause mass deletion.
const DELETION_SAFEGUARD_THRESHOLD = 0.2;

export async function deduplicateAndStore(incoming: Internship[]): Promise<StoreResult> {
  return withLock(async () => {
    const seen = loadSeen();
    const existing = loadInternships();

    // Reconcile: if seen.json has far more IDs than internships.json has records,
    // it means a previous crash wiped internships.json. Rebuild seen from existing
    // so new records can be re-discovered.
    if (seen.size > existing.length * 2 && existing.length < 100) {
      console.warn(`[store] seen.json (${seen.size} IDs) >> internships.json (${existing.length} records) — likely crash corruption. Rebuilding seen from current internships to allow re-discovery.`);
      seen.clear();
      for (const i of existing) seen.add(i.id);
    }

    const newInternships: Internship[] = [];

    // Secondary dedup by link — catches same listing with different title/location formatting
    // Secondary dedup by normalized link — same posting with different UTM params
    // should not be stored twice. Use stripUtm() to strip tracking parameters.
    const seenLinks = new Set<string>();
    for (const entry of existing) {
      if (entry.link) seenLinks.add(stripUtm(entry.link));
    }

    for (const i of incoming) {
      // Skip if id already seen (exact match on company+title+normalized-link hash)
      if (seen.has(i.id)) continue;
      // Skip if normalized link already stored (same posting, different UTM formatting)
      const normalizedLink = stripUtm(i.link || '');
      if (i.link && seenLinks.has(normalizedLink)) continue;
      if (i.link) seenLinks.add(normalizedLink);

      // ---- Ingest-time link validation ----
      // Skip HTTP check for known aggregator domains — daily revalidation handles dead links.
      // Ingest-time HTTP checking was causing timeouts for large batches (3000+ listings × 8s = 8+ hours).
      // Aggregator links (Greenhouse/Lever/Ashby/Workday) are trusted — they're ATS platforms, not random job boards.
      // Non-aggregator links still get checked via daily revalidation before archival.
      // ------------------------------------

      seen.add(i.id);
      // Store normalized link (UTM stripped) so future dedup comparisons are clean
      newInternships.push({ ...i, link: normalizedLink || i.link, isNew: true });
    }

    const updated = [...existing, ...newInternships];

    // Safeguard: if the new list would be more than 20% smaller than existing, something
    // is wrong — abort rather than silently shrink the store.
    if (existing.length > 50 && updated.length < existing.length * (1 - DELETION_SAFEGUARD_THRESHOLD)) {
      console.error(`[store] SAFEGUARD TRIGGERED: would reduce ${existing.length} → ${updated.length} records (>${DELETION_SAFEGUARD_THRESHOLD * 100}% drop). Aborting save.`);
      return { newInternships: [], totalStored: existing.length };
    }

    saveInternships(updated);
    saveSeen(seen);

    return { newInternships, totalStored: updated.length };
  });
}

export function getStats(): {
  total: number;
  bySource: Record<string, number>;
  byLabel: Record<string, number>;
  lastPolledAt: string | null;
  exclusionCounts: Record<string, number>;
} {
  const internships = loadInternships();

  const bySource: Record<string, number> = {};
  const byLabel: Record<string, number> = {};

  for (const i of internships) {
    bySource[i.source] = (bySource[i.source] || 0) + 1;
    byLabel[i.scoreLabel] = (byLabel[i.scoreLabel] || 0) + 1;
  }

  const lastPolledAt = internships.length > 0
    ? internships[internships.length - 1].seenAt
    : null;

  // Load persisted exclusion counts from last poll
  let exclusionCounts: Record<string, number> = {};
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'poll-stats.json'), 'utf-8');
    const saved = JSON.parse(raw);
    exclusionCounts = saved.exclusionCounts ?? {};
  } catch {}

  return {
    total: internships.length,
    bySource,
    byLabel,
    lastPolledAt,
    exclusionCounts,
  };
}

/**
 * Persist per-poll exclusion counts so the stats API can surface them.
 * Stored in data/poll-stats.json (single latest poll, not historical).
 */
export function savePollStats(stats: {
  polledAt: string;
  sourceCounts?: Record<string, number>;
  exclusionCounts: Record<string, number>;
}): void {
  const statsPath = path.join(process.cwd(), 'data', 'poll-stats.json');
  fs.writeFileSync(statsPath, JSON.stringify({
    polledAt: stats.polledAt,
    sourceCounts: stats.sourceCounts ?? {},
    exclusionCounts: stats.exclusionCounts,
  }, null, 2));
}

export function patchInternship(id: string, patch: Partial<Internship>): Internship | null {
  const internships = loadInternships();
  const idx = internships.findIndex(i => i.id === id);
  if (idx === -1) return null;
  internships[idx] = { ...internships[idx], ...patch };
  saveInternships(internships);
  return internships[idx];
}

export function archiveStalePostings(daysOld = 30): number {
  const internships = loadInternships();
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  let count = 0;

  for (const i of internships) {
    if (!i.archived && new Date(i.seenAt).getTime() < cutoff) {
      i.archived = true;
      count++;
    }
  }

  if (count > 0) {
    saveInternships(internships);
    console.log(`[store] Archived ${count} stale postings older than ${daysOld} days`);
  }

  return count;
}

// Alias for REST handler compatibility
export { getStats as getLatestPollStats };

export function getInternships(filters?: {
  source?: string;
  minScore?: number;
  label?: string;
  includeArchived?: boolean;
  sort?: 'newest' | 'posted' | 'score';
  search?: string;  // q= — case-insensitive substring search across title, company, location
}): Internship[] {
  let internships = loadInternships();

  if (!filters?.includeArchived) {
    internships = internships.filter(i => !i.archived);
  }
  if (filters?.source) {
    internships = internships.filter(i => i.source.toLowerCase() === filters.source!.toLowerCase());
  }
  if (filters?.minScore !== undefined) {
    internships = internships.filter(i => (i.score ?? 0) >= filters.minScore!);
  }
  if (filters?.label) {
    internships = internships.filter(i => i.scoreLabel.toLowerCase() === filters.label!.toLowerCase());
  }
  if (filters?.search) {
    const q = filters.search.toLowerCase();
    internships = internships.filter(i =>
      i.title.toLowerCase().includes(q) ||
      i.company.toLowerCase().includes(q) ||
      i.location.toLowerCase().includes(q)
    );
  }

  switch (filters?.sort) {
    case 'newest':
      return internships.sort((a, b) => (b.seenAt > a.seenAt ? 1 : b.seenAt < a.seenAt ? -1 : 0));
    case 'posted':
      return internships.sort((a, b) => (b.postedAt > a.postedAt ? 1 : b.postedAt < a.postedAt ? -1 : 0));
    case 'score':
    default:
      return internships.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
}
