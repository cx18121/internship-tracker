import type { PoolClient } from 'pg';
import { getPool } from '../db';
import type { Internship, StoredInternship } from '../types';
import type { RoleType, Degree, PostingClassification } from '../classify/posting';
import type { Salary } from '../salary';
import type { CompanyTier } from '../classify/company';
import { companyKey } from '../company-key';
import { normalizeKey } from '../normalize-key';
import { parseSeason } from '../seasons';
import { OpportunityIndex, mergeIdentities, identitiesAgree, compareOpportunityAge, sourceUrlKey, employerNames, employerSpelling, openingFacts } from '../opportunity';
import { postingKey, jobKey, discoverATSTarget, ATS_SOURCES } from '../../poller/ats';
import type { PostingIdentity } from '../types';

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
  /** Text projection retains PostgreSQL microseconds for canonical ID selection. */
  first_seen_precise?: string;
  archived: boolean;
  archive_reason: string | null;
  failed_check_count: number;
  last_checked_at: Date | null;
  locations: string[] | null;
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_unit: Salary['unit'];
  normalized_key: string | null;
  job_key: string | null;
  identities: PostingIdentity[] | null;
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
  ['archive_reason', i => i.archiveReason ?? null],
  ['failed_check_count', i => i.failedCheckCount],
  ['last_checked_at', i => i.lastCheckedAt ?? null],
  ['locations', i => JSON.stringify(i.locations)],
  ['salary_text', i => i.salaryText ?? null],
  ['salary_min', i => i.salaryMin ?? null],
  ['salary_max', i => i.salaryMax ?? null],
  ['salary_unit', i => i.salaryUnit ?? null],
  ['normalized_key', i => i.normalizedKey],
  ['job_key', i => i.jobKey ?? null],
  ['identities', i => JSON.stringify(i.identities ?? [])],
  ['company_key', i => companyKey(i.company)],
  ['season', i => JSON.stringify(i.season)],
  ['role_type', i => i.roleType ?? null],
  ['degrees', i => i.degrees ? JSON.stringify(i.degrees) : null],
  ['us_eligible', i => i.usEligible ?? null],
  ['is_internship', i => i.isInternship ?? null],
  ['classified_at', i => i.classifiedAt ?? null],
];

const COL_NAMES = COLUMNS.map(([c]) => c);
const INSERT_SQL = `INSERT INTO internships (${COL_NAMES.join(',')}) VALUES (${COL_NAMES.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING RETURNING id`;

function toValues(i: StoredInternship): unknown[] {
  return COLUMNS.map(([, get]) => get(i));
}

const iso = (d: Date | null): string | undefined => d?.toISOString();

function fromRow(r: Row): StoredInternship {
  return withEvidence({
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    description: r.description ?? undefined,
    link: r.link,
    source: r.source,
    postedAt: iso(r.posted_at),
    seenAt: r.seen_at.toISOString(),
    firstSeenAt: r.first_seen_precise ?? r.first_seen_at.toISOString(),
    archived: r.archived,
    archiveReason: r.archive_reason ?? undefined,
    failedCheckCount: r.failed_check_count,
    lastCheckedAt: iso(r.last_checked_at),
    locations: r.locations ?? (r.location ? [r.location] : []),
    salaryText: r.salary_text ?? undefined,
    salaryMin: r.salary_min ?? undefined,
    salaryMax: r.salary_max ?? undefined,
    salaryUnit: r.salary_unit ?? undefined,
    normalizedKey: r.normalized_key ?? '',
    jobKey: r.job_key ?? undefined,
    identities: r.identities ?? [],
    season: r.season ?? [],
    roleType: r.role_type ?? undefined,
    degrees: r.degrees ?? undefined,
    usEligible: r.us_eligible ?? undefined,
    isInternship: r.is_internship ?? undefined,
    classifiedAt: iso(r.classified_at),
    companyTier: r.company_tier ?? undefined,
  }, true);
}

// Every read joins the company's judged tier; present() then applies curated overrides.
const preciseFirstSeen = (prefix = '') => `to_char(${prefix}first_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_seen_precise`;
const SELECT = `SELECT i.*, ${preciseFirstSeen('i.')}, p.tier AS company_tier FROM internships i LEFT JOIN company_profiles p ON p.company_key = i.company_key AND i.company_key <> ''`;

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

// Both ingestion and daily cleanup serialize across processes, not just this mutex.
const OPPORTUNITY_LOCK = "SELECT pg_advisory_xact_lock(hashtext('internship-opportunities'))";

function withEvidence(i: StoredInternship, retained = false): StoredInternship {
  let identities: PostingIdentity[] = i.identities?.length ? i.identities : [{
    postingKey: postingKey(i.link), sourceUrl: i.link, title: i.title, terms: parseSeason(i.title),
    facts: openingFacts(i.description ?? ''),
  }];
  const linkKey = postingKey(i.link);
  if (retained && !linkKey.startsWith('url:') && !identities.some(x => x.postingKey === linkKey) &&
      identities.every(x => x.employer?.kind === 'source' && x.origin !== 'board' &&
        sourceUrlKey(x.sourceUrl) !== sourceUrlKey(i.link) && x.postingKey.slice(0,x.postingKey.lastIndexOf(':')) === linkKey.slice(0,linkKey.lastIndexOf(':')))) {
    // The accepted row's current application URL can outlive an old parser key
    // or board path. Retain both aliases rather than replacing qualified IDs.
    identities = [...identities, { postingKey: linkKey, sourceUrl: i.link, title: i.title, terms: parseSeason(i.title),
      facts: openingFacts(i.description ?? '') }];
  }
  return { ...i, identities: identities.map(x => {
    // Re-read old URL fallbacks with the current native parser. Never rewrite
    // an already qualified key, or infer another tenant from a numeric ID.
    const key = x.postingKey.startsWith('url:') ? postingKey(x.sourceUrl) : x.postingKey;
    const board = x.employer?.kind === 'greenhouse' || (ATS_SOURCES.includes(i.source) && key === postingKey(i.link));
    return { ...x, postingKey: key, origin: x.origin ?? (board ? 'board' : 'feed') };
  }) };
}

/** Folding preserves classification and archive policy. Fresh official observations
 * can repair link-health state, without becoming new opportunities or alerts. */
async function foldObservation(client: PoolClient, keep: StoredInternship, other: StoredInternship, rediscovery: boolean): Promise<StoredInternship> {
  if (!rediscovery && !identitiesAgree(keep.identities ?? [], other.identities ?? [])) {
    throw new Error('Cannot consolidate incompatible opening evidence');
  }
  const identities = mergeIdentities(keep.identities ?? [], other.identities ?? []);
  const union = [...new Set([...keep.locations, ...other.locations])];
  const concrete = union.filter(l => !/^\d+ locations?$/i.test(l));
  const locations = concrete.length ? concrete : union;
  const direct = (link: string) => discoverATSTarget(link, '') ? 2 : /linkedin\.com|simplify\.jobs/.test(link) ? 0 : 1;
  // Source is the origin of this observation, not the canonical row's historical
  // display label. Cached feed identity is not proof that an official board is live.
  const observedBoard = rediscovery && ATS_SOURCES.includes(other.source) && !postingKey(other.link).startsWith('url:');
  const link = (observedBoard && keep.failedCheckCount > 0) || direct(other.link) > direct(keep.link) ? other.link : keep.link;
  const liveBoard = observedBoard && postingKey(other.link) === postingKey(link);
  const title = liveBoard ? other.title : keep.title;
  const revive = (rediscovery && (keep.archiveReason === undefined || keep.archiveReason === 'not seen') && keep.failedCheckCount === 0) ||
    (liveBoard && keep.archiveReason === 'link gone');
  const salary = keep.salaryText ? keep : other;
  const terms = [...new Set(identities.flatMap(x => x.terms))];
  const season = terms.length ? terms.map(t => t.startsWith('year-') ? `summer-${t.slice(5)}` : t)
    : [...new Set([...keep.season, ...other.season])];
  const merged = { ...keep, title, identities, locations, location: locations[0] ?? keep.location,
    link, jobKey: jobKey(link), season,
    seenAt: keep.seenAt > other.seenAt ? keep.seenAt : other.seenAt,
    description: keep.description || other.description,
    postedAt: keep.postedAt ?? other.postedAt,
    salaryText: salary.salaryText, salaryMin: salary.salaryMin, salaryMax: salary.salaryMax, salaryUnit: salary.salaryUnit,
  };
  const updated = await client.query<Row>(`UPDATE internships SET
    seen_at=$2, first_seen_at=LEAST(first_seen_at, COALESCE((SELECT first_seen_at FROM internships WHERE id=$16), first_seen_at)),
    description=$3, posted_at=COALESCE(posted_at, $4), locations=$5, location=$6,
    salary_text=$7, salary_min=$8, salary_max=$9, salary_unit=$10, identities=$11,
    last_checked_at=CASE WHEN $17 THEN $18::timestamptz WHEN link <> $12 THEN NULL ELSE last_checked_at END,
    failed_check_count=CASE WHEN $17 THEN 0 ELSE failed_check_count END, link=$12, job_key=$13, season=$14,
    title=$19, normalized_key=$20,
    archived=CASE WHEN $15 THEN false ELSE archived END,
    archive_reason=CASE WHEN $15 THEN NULL ELSE archive_reason END
    WHERE id=$1 RETURNING *, ${preciseFirstSeen()}`, [keep.id, merged.seenAt, merged.description ?? null, merged.postedAt ?? null,
    JSON.stringify(locations), merged.location, merged.salaryText ?? null, merged.salaryMin ?? null, merged.salaryMax ?? null,
    merged.salaryUnit ?? null, JSON.stringify(identities), link, merged.jobKey, JSON.stringify(season), revive, other.id, liveBoard, other.seenAt,
    title, normalizeKey(keep.company, title)]);
  return fromRow(updated.rows[0]);
}

/** Successful source evidence can be reused without another per-posting HTTP request. */
export async function getPostingIdentities(keys: string[], sourceUrls: string[] = []): Promise<Map<string, PostingIdentity>> {
  if (!keys.length) return new Map();
  const urls = [...new Set(sourceUrls.flatMap(url => [url, sourceUrlKey(url)]).filter(Boolean))];
  const queries = [...keys.map(postingKey => JSON.stringify([{ postingKey }])), ...urls.map(sourceUrl => JSON.stringify([{ sourceUrl }]))];
  const { rows } = await getPool().query<Row>(
    `${SELECT} WHERE i.identities @> ANY($1::jsonb[]) OR i.link=ANY($2::text[]) ORDER BY i.seen_at DESC`, [queries,urls]);
  const identities = rows.flatMap(r => fromRow(r).identities ?? []);
  const wanted = new Set(keys), result = new Map<string, PostingIdentity>();
  for (const x of identities) if (wanted.has(x.postingKey) &&
    (!result.has(x.postingKey) || (x.origin === 'board' && result.get(x.postingKey)?.origin !== 'board'))) result.set(x.postingKey, x);
  for (const key of wanted) {
    const boards = identities.filter(x => x.origin === 'board' && x.postingKey === key);
    if (!identitiesAgree(boards,boards)) result.delete(key);
  }
  for (const url of urls) {
    const key = postingKey(url);
    if (!/^greenhouse:_:post:\d+$/.test(key)) continue;
    const id = key.split(':').at(-1);
    const candidates = identities.filter(x => /^greenhouse:(?!_:)[^:]+:post:\d+$/.test(x.postingKey) &&
      x.postingKey.endsWith(`:post:${id}`) && sourceUrlKey(x.sourceUrl) === sourceUrlKey(url));
    if (new Set(candidates.map(x => x.postingKey)).size === 1 && identitiesAgree(candidates,candidates)) result.set(key, candidates[0]);
    else if (candidates.length) result.delete(key);
  }
  return result;
}

// History can retain a source employer even after its display company changes.
// These names select candidates only. OpportunityIndex still owns proof.
const employerEvidenceMatches = (parameter: number) => `EXISTS (
  SELECT 1 FROM jsonb_array_elements(i.identities) AS evidence(value)
  CROSS JOIN LATERAL jsonb_array_elements_text(jsonb_build_array(evidence.value->'employer'->>'name') ||
    COALESCE(evidence.value->'employer'->'hiringNames','[]'::jsonb)) AS names(value)
  WHERE regexp_replace(lower(names.value),'[^[:alnum:]]','','g')=ANY($${parameter}::text[]))`;

/** Display company names and retained source employers are retrieval hints only. */
export async function getIdentityCandidates(companies: string[], employers: string[] = []): Promise<StoredInternship[]> {
  if (!companies.length && !employers.length) return [];
  const keys = [...new Set(companies.map(companyKey).filter(Boolean))];
  const names = [...new Set(employers.map(employerSpelling).filter(Boolean))];
  const { rows } = await getPool().query<Row>(`${SELECT} WHERE (i.company_key=ANY($1::text[]) OR ${employerEvidenceMatches(2)})
    AND (i.archive_reason IS DISTINCT FROM 'duplicate') ORDER BY i.archived,i.first_seen_at,i.id`, [keys,names]);
  return rows.map(fromRow);
}

/** Backfill source evidence onto existing IDs without inserting, notifying, or changing archive/classification state. */
export async function saveExistingIdentities(updates: Array<{ id: string; identities: PostingIdentity[]; description?: string }>): Promise<void> {
  if (!updates.length) return;
  await withLock(() => withTxn(async client => {
    await client.query(OPPORTUNITY_LOCK);
    const existing = (await client.query<Row>(`${SELECT} WHERE i.id=ANY($1::text[])`, [updates.map(x => x.id)])).rows.map(fromRow);
    const byId = new Map(existing.map(x => [x.id, x]));
    for (const update of updates) {
      const row = byId.get(update.id);
      if (!row) continue;
      row.identities = mergeIdentities(row.identities ?? [], update.identities);
      await client.query(`UPDATE internships SET identities=$2, description=COALESCE(NULLIF(description,''),$3) WHERE id=$1`,
        [row.id, JSON.stringify(row.identities), update.description ?? null]);
    }
  }));
}

/** Match before alerting; persist every accepted alias and return final same-batch metadata. */
export async function deduplicateAndStore(input: StoredInternship[]): Promise<StoreResult> {
  return withLock(() => withTxn(async (client) => {
    await client.query(OPPORTUNITY_LOCK);
    const incoming = input.map(i => withEvidence(i));
    const aliases = incoming.flatMap(i => i.identities!.flatMap(x =>
      ['postingKey', 'openingKey', 'requisitionKey', 'sourceUrl'].flatMap(field => {
        const value = x[field as keyof PostingIdentity];
        return value ? [JSON.stringify([{ [field]: value }])] : [];
      })));
    // Company keys only retrieve history. Raw employer, role, content and
    // requisition evidence still own every matching decision.
    const companyKeys = [...new Set(incoming.map(i => companyKey(i.company)).filter(Boolean))];
    const employers = [...new Set(incoming.flatMap(i => i.identities!.flatMap(employerNames)))];
    const existing = (await client.query<Row>(`${SELECT} WHERE i.archived=false OR i.id=ANY($1::text[]) OR i.identities @> ANY($2::jsonb[]) OR i.company_key=ANY($3::text[]) OR ${employerEvidenceMatches(4)}`,
      [incoming.map(i => i.id), aliases, companyKeys, employers])).rows.map(fromRow);
    const index = new OpportunityIndex(existing, incoming);
    const newIds = new Set<string>();

    for (const i of incoming) {
      const old = index.get(i.id);
      const match = index.find(i);
      let keep = match ?? old;
      if (keep) {
        // An enriched existing row may now match another stored variant. Keep
        // the oldest canonical ID even when it was temporarily archived.
        if (old && match && old.id !== match.id) {
          if (old.archiveReason !== 'duplicate' && compareOpportunityAge(old, match) < 0) keep = old;
          const absorbed = keep.id === old.id ? match : old;
          keep = await foldObservation(client, keep, absorbed, false);
          if (!absorbed.archived) {
            await client.query("UPDATE internships SET archived=true, archive_reason='duplicate' WHERE id=$1", [absorbed.id]);
            index.add({ ...absorbed, archived: true, archiveReason: 'duplicate' });
            newIds.delete(absorbed.id);
          }
        }
        keep = await foldObservation(client, keep, i, true);
        index.add(keep);
        continue;
      }
      const inserted = await client.query(INSERT_SQL, toValues(i));
      if (inserted.rowCount) { index.add(i); newIds.add(i.id); }
    }

    const newInternships = newIds.size ? (await client.query<Row>(`${SELECT} WHERE i.id=ANY($1::text[]) AND i.archived=false`, [[...newIds]])).rows.map(fromRow) : [];
    const netNewBySource: Record<string, number> = {};
    for (const i of newInternships) netNewBySource[i.source] = (netNewBySource[i.source] ?? 0) + 1;
    const count = await client.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM internships');
    return { newInternships, totalStored: +count.rows[0].n, netNewBySource };
  }));
}

/** Daily cleanup delegates to the same matcher and folds metadata atomically. */
export async function consolidateOpportunities(): Promise<number> {
  return withLock(() => withTxn(async client => {
    await client.query(OPPORTUNITY_LOCK);
    const rows = (await client.query<Row>(`${SELECT} WHERE i.archived=false OR i.archive_reason IS DISTINCT FROM 'duplicate' ORDER BY i.first_seen_at, i.id`)).rows.map(fromRow);
    const index = new OpportunityIndex(rows);
    let archived = 0;
    for (const row of rows) {
      const current = index.get(row.id)!;
      if (current.archived) continue;
      const match = index.find(current);
      if (!match) continue;
      const [keep, duplicate] = [current, match].sort(compareOpportunityAge);
      index.add(await foldObservation(client, keep, duplicate, false));
      await client.query("UPDATE internships SET archived=true, archive_reason='duplicate' WHERE id=$1", [duplicate.id]);
      index.add({ ...duplicate, archived: true, archiveReason: 'duplicate' });
      archived++;
    }
    return archived;
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
