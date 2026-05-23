import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Internship } from '../../lib/types';
import { discoverATSTarget, saveDiscoveredTargets } from '../../lib/utils/ats-discovery';
import { stripHtml } from '../utils/html';

const README_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md';

// Persistent cache of resolved simplify.jobs apply URLs so we don't re-hit
// the click endpoint for the same posting every cycle. Keyed by posting uuid.
const SIMPLIFY_CACHE_PATH = path.join(process.cwd(), 'data', 'simplify-resolved.json');

function loadSimplifyCache(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SIMPLIFY_CACHE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSimplifyCache(cache: Record<string, string>): void {
  try {
    fs.writeFileSync(SIMPLIFY_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // Best-effort — cache miss is recoverable.
  }
}

/**
 * Resolves https://simplify.jobs/p/{uuid} to the underlying ATS apply URL
 * by following the click-tracking 307 from /jobs/click/{uuid}. Returns the
 * resolved URL, or null if resolution fails (caller should keep the original).
 */
async function resolveSimplifyApplyUrl(
  simplifyLink: string,
  cache: Record<string, string>,
): Promise<string | null> {
  const m = simplifyLink.match(/simplify\.jobs\/p\/([0-9a-fA-F-]+)/);
  if (!m) return null;
  const uuid = m[1];
  if (cache[uuid]) return cache[uuid];
  try {
    const resp = await axios.head(`https://simplify.jobs/jobs/click/${uuid}`, {
      timeout: 8000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    const loc = resp.headers?.location;
    if (typeof loc === 'string' && loc.startsWith('http') && !loc.includes('simplify.jobs')) {
      cache[uuid] = loc;
      return loc;
    }
  } catch {
    // Network error — fall through to null and keep the original simplify link.
  }
  return null;
}

// The README uses HTML table format: <tr><td>...</td></tr>
// Cell 0: Company — <strong><a href="...">Name</a></strong>
// Cell 1: Title (text)
// Cell 2: Location (text)
// Cell 3: Apply link — <a href="apply-url">...</a>
// Cell 4: Days posted

/**
 * Parse a multi-location <details><summary> cell.
 * Input e.g.: <details><summary><strong>6 locations</strong></summary>California<br>SF<br>Arizona...</details>
 * Returns { count, locations[] } or null if not a multi-location cell.
 */
function parseMultiLocation(cellHtml: string): { count: number; locations: string[] } | null {
  const countMatch = cellHtml.match(/<strong>(\d+)\s+locations?<\/strong>/i);
  if (!countMatch) return null;
  const count = +countMatch[1];
  // Extract text content after the closing </summary>, splitting on <br>
  const afterSummary = cellHtml.replace(/<\/summary>/i, '\n').replace(/<[^>]+>/g, '\n');
  const locations = afterSummary.split('\n').map(s => s.trim()).filter(s => s && !/^\d+$/.test(s) && !s.toLowerCase().includes('location'));
  return { count, locations };
}

function extractHref(html: string): string {
  // Find the first job application link (greenhouse, lever, workday, etc.)
  // Avoid simplify.jobs links as primary; prefer direct apply links
  const hrefMatches = [...html.matchAll(/href="([^"]+)"/g)];
  for (const [, href] of hrefMatches) {
    if (
      href.includes('greenhouse.io') ||
      href.includes('lever.co') ||
      href.includes('workday') ||
      href.includes('myworkdayjobs') ||
      href.includes('careers') ||
      href.includes('jobs') ||
      href.includes('apply') ||
      href.includes('smartrecruiters') ||
      href.includes('ashbyhq') ||
      href.includes('icims')
    ) {
      return href;
    }
  }
  // Fallback to simplify.jobs
  for (const [, href] of hrefMatches) {
    if (href.includes('simplify.jobs')) return href;
  }
  return hrefMatches[0]?.[1] || '';
}

function parseRows(html: string): { company: string; title: string; location: string; link: string; multiLocation?: string[] }[] {
  const results = [];

  // Match all <tr> blocks
  const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
  let trMatch: RegExpExecArray | null;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1];

    // Extract <td> cells
    const cells: string[] = [];
    const tdRegex = /<td>([\s\S]*?)<\/td>/g;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      cells.push(tdMatch[1].trim());
    }

    if (cells.length < 4) continue;

    const company = stripHtml(cells[0]);
    const title = stripHtml(cells[1]);
    const locationRaw = cells[2];

    // Detect multi-location cells (contain <details>) — when present, use
    // the first parsed location as the primary `location` field. stripHtml
    // on the <details> cell concatenates the children into a single string
    // and occasionally drops the separator, producing artifacts like
    // "State College, PAReston, VA" (PA + Reston with no space/comma).
    // The full list is preserved in multiLocation for the UI.
    const multiLoc = parseMultiLocation(locationRaw);
    const location = multiLoc?.locations[0] || stripHtml(locationRaw);
    const link = extractHref(cells[3]);

    if (company === '↳') continue; // continuation row for multi-location, skip
    if (!company || !title || company.toLowerCase() === 'company') continue;

    const row = { company, title, location, link };
    if (multiLoc) {
      (row as any).multiLocation = multiLoc.locations;
    }
    results.push(row);
  }

  return results;
}

/**
 * Best-effort description fetch by ATS type. Returns '' if the URL is from an
 * ATS we don't handle here, or on any error — descriptions are nice-to-have.
 */
async function fetchDescriptionByUrl(url: string): Promise<string> {
  if (!url) return '';
  try {
    // Greenhouse: https://(boards|job-boards).greenhouse.io/{slug}/jobs/{id}
    let m = url.match(/greenhouse\.io\/(?:boards\/)?([^/]+)\/jobs\/(\d+)/);
    if (m) {
      const [, slug, jobId] = m;
      const { data } = await axios.get(
        `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?content=true`,
        { timeout: 8000 },
      );
      return stripHtml(data?.content ?? '').slice(0, 4000);
    }
    // Lever: https://jobs.lever.co/{slug}/{id}
    m = url.match(/jobs\.lever\.co\/([^/?#]+)\/([a-f0-9-]+)/);
    if (m) {
      const [, slug, jobId] = m;
      const { data } = await axios.get(
        `https://api.lever.co/v0/postings/${slug}/${jobId}?mode=json`,
        { timeout: 8000 },
      );
      if (data?.descriptionPlain) return data.descriptionPlain.slice(0, 4000);
      const parts = [
        stripHtml(data?.description ?? ''),
        ...((data?.lists ?? []) as Array<{ text?: string; content?: string }>)
          .map(l => `${l.text ?? ''} ${stripHtml(l.content ?? '')}`),
      ];
      return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
    }
    // Ashby: https://jobs.ashbyhq.com/{slug}/{id}
    m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([^/?#]+)/);
    if (m) {
      const [, slug, jobId] = m;
      const { data: html } = await axios.get(`https://jobs.ashbyhq.com/${slug}/${jobId}`, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
        responseType: 'text',
      });
      // Accept newline OR </script> after the trailing semicolon — see
      // matching note in pollers/ats.ts fetchAshbyDescription.
      const am = (html as string).match(/window\.__appData\s*=\s*(\{.*?\});\s*(?:\n|<\/script>|$)/s);
      if (!am) {
        console.warn(`[github] Ashby ${slug}/${jobId}: __appData regex missed — markup may have changed`);
        return '';
      }
      const appData = JSON.parse(am[1]);
      const posting = appData?.posting
        ?? appData?.jobBoard?.jobPostings?.find((p: { id: string }) => p.id === jobId)
        ?? appData?.jobBoard?.jobPostings?.[0];
      return stripHtml(posting?.descriptionHtml ?? '').slice(0, 4000);
    }
    return '';
  } catch {
    return '';
  }
}

async function withConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function pollGitHub(): Promise<Partial<Internship>[]> {
  const response = await axios.get<string>(README_URL, { responseType: 'text', timeout: 15000 });
  const readme = response.data;

  const rows = parseRows(readme);

  // Upgrade simplify.jobs fallback links to the real ATS apply URL. The
  // README only has a simplify.jobs link when no direct ATS link was
  // available, so we ask simplify's own click endpoint for the redirect
  // target. Cached per uuid to avoid hitting the endpoint every cycle.
  const simplifyCache = loadSimplifyCache();
  const simplifyRows = rows.filter((r) => r.link.includes('simplify.jobs/p/'));
  if (simplifyRows.length > 0) {
    let resolved = 0;
    const before = Object.keys(simplifyCache).length;
    await withConcurrency(simplifyRows, 10, async (row) => {
      const real = await resolveSimplifyApplyUrl(row.link, simplifyCache);
      if (real) {
        row.link = real;
        resolved++;
      }
    });
    if (Object.keys(simplifyCache).length > before) saveSimplifyCache(simplifyCache);
    console.log(`[github poller] Resolved ${resolved}/${simplifyRows.length} simplify.jobs links to direct apply URLs`);
  }

  const results: Partial<Internship>[] = rows.map(row => {
    const atsTarget = discoverATSTarget(row.link, row.company);
    const entry: Partial<Internship> = {
      title: row.title,
      company: row.company,
      location: row.location,
      link: row.link,
      source: 'SimplifyJobs',
      atsSource: atsTarget ? atsTarget.ats : 'unknown',
      postedAt: new Date().toISOString(),
      seenAt: new Date().toISOString(),
      applied: false,
    };
    if (row.multiLocation && row.multiLocation.length > 0) {
      entry.multiLocation = row.multiLocation;
    }
    return entry;
  });

  // Best-effort description backfill via the linked ATS — Greenhouse/Lever/Ashby covered.
  // Concurrency-limited so we don't hammer any one host. Failures silently leave description empty.
  let enriched = 0;
  await withConcurrency(results, 5, async (entry) => {
    if (!entry.link) return;
    const desc = await fetchDescriptionByUrl(entry.link);
    if (desc) { entry.description = desc; enriched++; }
  });
  console.log(`[github poller] Description backfill: ${enriched}/${results.length} via ATS APIs`);

  // Auto-discover new ATS targets from direct links in SimplifyJobs
  const discovered = rows
    .map(row => discoverATSTarget(row.link, row.company))
    .filter((t): t is NonNullable<typeof t> => t !== null);
  const added = saveDiscoveredTargets(discovered);
  if (added > 0) {
    console.log(`[github poller] Auto-discovered ${added} new ATS target(s)`);
  }

  console.log(`[github poller] Fetched ${results.length} postings from SimplifyJobs`);
  return results;
}
