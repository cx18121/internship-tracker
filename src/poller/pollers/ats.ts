import axios from 'axios';
import { Internship, ATSTarget } from '../../lib/types';
import { loadATSTargets } from '../../lib/utils/ats-discovery';
import { INTERN_SIGNAL_RE, isInternTitle } from '../utils/intern-signal';
import { stripHtml } from '../utils/html';
import {
  extractLeverDescription,
  fetchAshbyDescription,
  fetchSmartRecruitersDescription,
  fetchRipplingDescription,
} from '../utils/description-fetchers';
import { buildInternshipRow } from '../utils/build-row';
import { pool } from '../../lib/concurrency';
import { jsonStore } from '../../lib/sidecar';
import { closeBrowserSafely } from '../utils/browser';

// Upper-bound safety on raw description size — descriptions feed the scorer
// pre-truncation, so a verbose 50KB Workday posting would otherwise blow up
// per-cycle memory. smartTrimDescription in agent.ts re-caps to 2000 chars
// for storage; this constant is only the load-bearing memory floor.
const MAX_RAW_DESC = 20_000;

const REQUEST_TIMEOUT = 10_000;

export { isInternTitle };

async function pollGreenhouse(target: ATSTarget, now: string): Promise<Partial<Internship>[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${target.slug}/jobs?content=true`;
  const { data } = await axios.get(url, { timeout: REQUEST_TIMEOUT });
  const company = target.name || target.slug;
  return (data.jobs || [])
    .filter((j: any) => INTERN_SIGNAL_RE.test(j.title || ''))
    .map((j: any) => buildInternshipRow({
      title: stripHtml(j.title || ''),
      company,
      location: j.location?.name,
      link: j.absolute_url || `https://boards.greenhouse.io/${target.slug}/jobs/${j.id}`,
      source: 'Greenhouse',
      upstreamPostedAt: j.updated_at,
      seenAt: now,
      descriptionHtml: typeof j.content === 'string' ? j.content.slice(0, MAX_RAW_DESC) : undefined,
    }));
}

async function pollLever(target: ATSTarget, now: string): Promise<Partial<Internship>[]> {
  const url = `https://api.lever.co/v0/postings/${target.slug}?mode=json`;
  const { data } = await axios.get(url, { timeout: REQUEST_TIMEOUT });
  const postings: any[] = Array.isArray(data) ? data : [];
  const company = target.name || target.slug;
  return postings
    .filter((j) => {
      // Check title explicitly — don't OR-short-circuit to commitment if title exists
      // e.g. "UK Meritocracy Fellowship" with commitment="Internship" must still pass
      const titleMatch = isInternTitle(j.text || '');
      const commitmentMatch = (j.categories?.commitment || '').toLowerCase() === 'internship';
      return titleMatch || commitmentMatch;
    })
    .map((j) => buildInternshipRow({
      title: j.text || '',
      company,
      // Lever workplaceType is an internal enum ("remote"/"onsite"/"hybrid"/
      // "unspecified"). Only "remote" is a meaningful display location; the
      // rest are not place names, so fall back to empty rather than show
      // "onsite"/"unspecified".
      location: j.categories?.location || (String(j.workplaceType).toLowerCase() === 'remote' ? 'Remote' : ''),
      link: j.hostedUrl || j.applyUrl || '',
      source: 'Lever',
      upstreamPostedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
      seenAt: now,
      description: extractLeverDescription(j),
    }));
}

async function pollAshby(target: ATSTarget, now: string): Promise<Partial<Internship>[]> {
  // Ashby embeds job data in window.__appData on the job board page
  const { data: html } = await axios.get(`https://jobs.ashbyhq.com/${target.slug}`, {
    timeout: REQUEST_TIMEOUT,
    headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' },
    responseType: 'text',
  });

  const match = (html as string).match(/window\.__appData\s*=\s*(\{.*?\});\s*(?:\n|<\/script>|$)/s);
  if (!match) {
    console.warn(`[ats] Ashby ${target.slug}: __appData regex missed on board page — markup may have changed`);
    return [];
  }

  let appData: any;
  try {
    appData = JSON.parse(match[1]);
  } catch {
    console.warn(`[ats] Ashby ${target.slug}: failed to parse __appData JSON`);
    return [];
  }
  const postings: any[] = appData?.jobBoard?.jobPostings || [];
  const company = target.name || appData?.organization?.name || target.slug;

  const interns = postings.filter((j) => {
    const titleMatch = INTERN_SIGNAL_RE.test(j.title || '');
    const typeMatch = INTERN_SIGNAL_RE.test(j.employmentType || '');
    return titleMatch || typeMatch;
  });

  const results: Partial<Internship>[] = [];
  for (const j of interns) {
    const description = await fetchAshbyDescription(target.slug, j.id);
    results.push(buildInternshipRow({
      title: j.title || '',
      company,
      location: j.workplaceType === 'Remote'
        ? 'Remote'
        : (j.locationName || j.locationExternalName),
      link: `https://jobs.ashbyhq.com/${target.slug}/${j.id}`,
      source: 'Ashby',
      upstreamPostedAt: j.publishedDate,
      seenAt: now,
      description,
    }));
  }
  return results;
}

// Public job URLs are rooted at the board, not the host: externalPath ("/job/…")
// is relative to it. Site-variant boards additionally sit under /recruiting/.
export function workdayBoardUrl(
  baseHost: string,
  tenant: string,
  board: string,
  isSiteVariant: boolean,
): string {
  return isSiteVariant
    ? `https://${baseHost}/recruiting/${tenant}/${board}`
    : `https://${baseHost}/${board}`;
}

async function fetchWorkdayDescription(
  baseHost: string,
  tenant: string,
  board: string,
  externalPath: string,
): Promise<string> {
  // CXS detail endpoint: /wday/cxs/{tenant}/{board}{externalPath}
  // (externalPath already starts with /job/…)
  try {
    const { data } = await axios.get(
      `https://${baseHost}/wday/cxs/${tenant}/${board}${externalPath}`,
      {
        timeout: REQUEST_TIMEOUT,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      },
    );
    const raw = data?.jobPostingInfo?.jobDescription || '';
    return stripHtml(raw).slice(0, MAX_RAW_DESC);
  } catch {
    return '';
  }
}

/**
 * Pure helper: given a Workday CXS /jobs response, extract the facet IDs
 * that categorize roles as interns/co-ops. Match by descriptor regex against
 * an allowlist of facet parameters known to carry role-type buckets
 * (jobFamilyGroup, workerSubType). Returned shape is suitable to use
 * directly as `appliedFacets` on a subsequent /jobs call.
 *
 * Empty result is meaningful — tenant has no intern facet, caller should
 * fall back to `searchText: 'intern'` instead of false-filtering everything.
 */
const WD_FACET_PARAMS_WITH_INTERN_BUCKETS = ['jobFamilyGroup', 'workerSubType'];
const INTERN_DESCRIPTOR_RE = /\bintern(s|ship|ships)?\b|\bco-?op\b/i;

interface WorkdayFacetsResponse {
  facets?: Array<{
    facetParameter?: string;
    values?: Array<{ id: string; descriptor: string; count?: number }>;
  }>;
}

export function extractInternFacets(response: WorkdayFacetsResponse): { [facetParameter: string]: string[] } {
  const result: { [k: string]: string[] } = {};
  for (const facet of (response.facets ?? [])) {
    if (!facet.facetParameter) continue;
    if (!WD_FACET_PARAMS_WITH_INTERN_BUCKETS.includes(facet.facetParameter)) continue;
    const matched = (facet.values ?? []).filter(v => INTERN_DESCRIPTOR_RE.test(v.descriptor));
    if (matched.length > 0) {
      result[facet.facetParameter] = matched.map(v => v.id);
    }
  }
  return result;
}

async function pollWorkday(
  target: ATSTarget,
  now: string,
  facetDiscoveries?: Map<string, { [k: string]: string[] }>,
): Promise<Partial<Internship>[]> {
  const tenant = target.slug;
  const board = target.board || '';
  const wdInstance = target.wdInstance || 'wd1';
  const isSiteVariant = target.wdDomain === 'myworkdaysite.com';
  // myworkdaysite.com: {wdInstance}.myworkdaysite.com/wday/cxs/{slug}/{board}/jobs
  // myworkdayjobs.com: {slug}.{wdInstance}.myworkdayjobs.com/wday/cxs/{slug}/{board}/jobs
  const baseHost = isSiteVariant
    ? `${wdInstance}.myworkdaysite.com`
    : `${tenant}.${wdInstance}.myworkdayjobs.com`;
  const url = `https://${baseHost}/wday/cxs/${tenant}/${board}/jobs`;
  const wdHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0',
  };

  const WD_PAGE = 20;
  const WD_MAX_POSTINGS = 2000;
  const company = target.name || target.slug;

  const discoverFacets = async (): Promise<{ [k: string]: string[] }> => {
    const { data } = await axios.post(
      url,
      { appliedFacets: {}, limit: 1, offset: 0, searchText: '' },
      { timeout: REQUEST_TIMEOUT, headers: wdHeaders },
    );
    return extractInternFacets(data);
  };
  const fetchAllPostings = async (appliedFacets: { [k: string]: string[] }): Promise<any[]> => {
    const all: any[] = [];
    for (let offset = 0; offset < WD_MAX_POSTINGS; offset += WD_PAGE) {
      const { data } = await axios.post(
        url,
        { appliedFacets, limit: WD_PAGE, offset, searchText: '' },
        { timeout: REQUEST_TIMEOUT, headers: wdHeaders },
      );
      const total: number | null = data.total ?? null;
      if (offset === 0 && total != null && total > WD_MAX_POSTINGS) {
        console.warn(`[ats] ${company} (workday): ${total} postings exceeds the ${WD_MAX_POSTINGS} scan budget and has no intern facet — skipping, since a partial scan would archive live roles`);
        return [];
      }
      const batch: any[] = data.jobPostings || [];
      all.push(...batch);
      if (batch.length < WD_PAGE) return all;
      if (total != null && all.length >= total) return all;
    }
    console.warn(`[ats] ${company} (workday): hit ${WD_MAX_POSTINGS}-posting cap without a total; results may be incomplete`);
    return all;
  };

  let facets = target.wdInternFacets;
  if (facets == null) {
    facets = await discoverFacets();
    facetDiscoveries?.set(tenant, facets);
  }
  const internFacets = (): { [k: string]: string[] } =>
    facets && Object.keys(facets).length > 0 ? facets : {};

  let postings: any[];
  try {
    postings = await fetchAllPostings(internFacets());
  } catch (e: any) {
    if (e?.response?.status !== 400) throw e;
    facets = await discoverFacets();
    facetDiscoveries?.set(tenant, facets);
    postings = await fetchAllPostings(internFacets());
  }
  const interns = postings.filter((j) => isInternTitle(j.title || ''));

  // Concurrent description fetches (cap 5) so a tenant with 20 interns adds
  // ~12s instead of ~60s. Workday list endpoint doesn't include descriptions;
  // they're only on the per-job CXS detail call.
  const descriptions = new Map<string, string>();
  await pool(interns, 5, async (j) => {
    descriptions.set(j.externalPath, await fetchWorkdayDescription(baseHost, tenant, board, j.externalPath));
  });

  return interns.map((j) => {
    // Workday sometimes returns a facility/campus name (e.g. "Hendrick Motorsports") as
    // locationsText rather than a city. If it just echoes the company name, fall back.
    const rawLoc = j.locationsText || '';
    const location = (rawLoc && rawLoc !== company) ? rawLoc : 'United States';
    return buildInternshipRow({
      title: j.title || '',
      company,
      location,
      link: `${workdayBoardUrl(baseHost, tenant, board, isSiteVariant)}${j.externalPath}`,
      source: 'Workday',
      seenAt: now,
      description: descriptions.get(j.externalPath),
    });
  });
}

async function pollICIMS(target: ATSTarget, now: string): Promise<Partial<Internship>[]> {
  // slug is used as the iCIMS tenantId
  const tenantId = target.slug;
  const url = `https://careers-${tenantId}.icims.com/jobs/search?ss=1&searchKeyword=intern&searchLocation=&in_iframe=1`;
  const { data: html } = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    responseType: 'text',
  });
  const company = target.name || tenantId;
  const results: Partial<Internship>[] = [];

  // Parse <li class="iCIMS_JobsTable_Item"> blocks
  const itemPattern = /<li[^>]*class="[^"]*iCIMS_JobsTable_Item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  const linkPattern = /href="([^"]*\/jobs\/(\d+)\/[^"]*)"[^>]*>\s*(.*?)\s*<\/a>/i;

  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemPattern.exec(html)) !== null) {
    const block = itemMatch[1];
    const linkMatch = linkPattern.exec(block);
    if (!linkMatch) continue;
    const relLink = linkMatch[1];
    const jobId = linkMatch[2];
    const title = linkMatch[3].replace(/<[^>]+>/g, '').trim();
    if (!isInternTitle(title)) continue;
    results.push(buildInternshipRow({
      title,
      company,
      location: 'United States',
      link: relLink.startsWith('http')
        ? relLink
        : `https://careers-${tenantId}.icims.com/jobs/${jobId}/job`,
      source: 'iCIMS',
      seenAt: now,
    }));
  }
  return results;
}

async function pollSmartRecruiters(target: ATSTarget, now: string): Promise<Partial<Internship>[]> {
  const url = `https://api.smartrecruiters.com/v1/companies/${target.slug}/postings?status=PUBLIC&limit=100`;
  const { data } = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  const postings: any[] = data.content || [];
  const company = target.name || target.slug;
  const interns = postings.filter((j) => {
    const titleMatch = isInternTitle(j.name || '');
    const typeMatch = /intern/i.test(j.typeOfEmployment?.id || '');
    return titleMatch || typeMatch;
  });

  const results: Partial<Internship>[] = [];
  for (const j of interns) {
    const description = await fetchSmartRecruitersDescription(target.slug, j.id);
    results.push(buildInternshipRow({
      title: j.name || '',
      company,
      location: [j.location?.city, j.location?.region, j.location?.country]
        .filter(Boolean).join(', ') || 'United States',
      link: `https://jobs.smartrecruiters.com/${target.slug}/${j.id}`,
      source: 'SmartRecruiters',
      upstreamPostedAt: j.releasedDate,
      seenAt: now,
      description,
    }));
  }
  return results;
}

async function pollRippling(target: ATSTarget, now: string): Promise<Partial<Internship>[]> {
  const url = `https://api.rippling.com/platform/api/ats/v1/board/${target.slug}/jobs`;
  const { data } = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  const postings: any[] = Array.isArray(data) ? data : [];
  const company = target.name || target.slug;

  // Rippling lists a role once per location, all sharing one uuid. Group by
  // uuid so a 3-location posting becomes a single multi-location row — emitting
  // three rows would just collapse to an arbitrary one on link-dedup (all three
  // carry the same job.url) and lose the other locations.
  const byUuid = new Map<string, { job: any; locations: string[] }>();
  for (const j of postings) {
    if (!isInternTitle(j.name || '')) continue;
    const loc = j.workLocation?.label;
    const entry = byUuid.get(j.uuid);
    if (entry) {
      if (loc && !entry.locations.includes(loc)) entry.locations.push(loc);
    } else {
      byUuid.set(j.uuid, { job: j, locations: loc ? [loc] : [] });
    }
  }
  const grouped = [...byUuid.values()];

  // Descriptions live only on the per-job detail endpoint (like Workday). Fetch
  // concurrently, cap 5, so a board with many interns stays bounded.
  const descriptions = new Map<string, string>();
  await pool(grouped, 5, async ({ job }) => {
    descriptions.set(job.uuid, await fetchRipplingDescription(target.slug, job.uuid));
  });

  return grouped.map(({ job, locations }) => ({
    ...buildInternshipRow({
      title: job.name || '',
      company,
      location: locations[0] || '',
      link: job.url || `https://ats.rippling.com/${target.slug}/jobs/${job.uuid}`,
      source: 'Rippling',
      seenAt: now,
      description: descriptions.get(job.uuid),
    }),
    ...(locations.length > 1 ? { multiLocation: locations } : {}),
  }));
}

async function pollWorkable(target: ATSTarget, now: string): Promise<Partial<Internship>[]> {
  // Public job-list endpoint is a POST with an empty filter body.
  const url = `https://apply.workable.com/api/v3/accounts/${target.slug}/jobs`;
  const { data } = await axios.post(url, {}, {
    timeout: REQUEST_TIMEOUT,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  const postings: any[] = data?.results || [];
  const company = target.name || target.slug;
  // Title-only match: Workable's `type` for interns is "temporary", which also
  // covers non-intern contract roles — too broad to use as a signal. The list
  // endpoint carries no description, so (like iCIMS) rows ship without one.
  return postings
    .filter((j) => isInternTitle(j.title || ''))
    .map((j) => {
      const loc = j.location || {};
      const isRemote = j.remote === true || String(j.workplace).toLowerCase() === 'remote';
      const location = loc.city
        ? [loc.city, loc.region, loc.country].filter(Boolean).join(', ')
        : (isRemote ? 'Remote' : (loc.country || ''));
      return buildInternshipRow({
        title: j.title || '',
        company,
        location,
        link: `https://apply.workable.com/${target.slug}/j/${j.shortcode}/`,
        source: 'Workable',
        upstreamPostedAt: j.published,
        seenAt: now,
      });
    });
}

async function pollWorkdayPlaywright(
  csrfTargets: ATSTarget[],
  now: string,
): Promise<{ jobs: Partial<Internship>[]; csrfConfirmedSlugs: string[]; csrfFailedSlugs: string[] }> {
  if (csrfTargets.length === 0) return { jobs: [], csrfConfirmedSlugs: [], csrfFailedSlugs: [] };
  const { firefox } = await import('playwright');
  const browser = await firefox.launch({ headless: true });
  const jobs: Partial<Internship>[] = [];
  const csrfConfirmedSlugs: string[] = [];
  const csrfFailedSlugs: string[] = [];

  const CONCURRENCY = parseInt(process.env.WORKDAY_PLAYWRIGHT_CONCURRENCY || '4', 10);

  async function pollOnePw(target: ATSTarget): Promise<void> {
    const tenant = target.slug;
    const wdInstance = target.wdInstance || 'wd1';
    const board = target.board || '';
    const isSiteVariant = target.wdDomain === 'myworkdaysite.com';
    if (!board) {
      console.warn(`[ats] Workday Playwright ${tenant}: no board name configured — skipping`);
      return;
    }
    const baseHost = isSiteVariant
      ? `${wdInstance}.myworkdaysite.com`
      : `${tenant}.${wdInstance}.myworkdayjobs.com`;
    // Site-variant board pages require the /recruiting/ prefix; without it
    // the page 404s and no CSRF cookie is provisioned. The direct CXS API
    // path (apiPath) does NOT need that prefix.
    const boardUrl = workdayBoardUrl(baseHost, tenant, board, isSiteVariant);
    const apiPath = `/wday/cxs/${tenant}/${board}/jobs`;

    const page = await browser.newPage();
    try {
      await page.goto(boardUrl, { waitUntil: 'networkidle', timeout: 30000 });

      // Workday's CSRF cookie (CALYPSO_CSRF_TOKEN) is HttpOnly, so document.cookie
      // inside page.evaluate can't see it. Read via the outer browser-context API.
      const cookies = await page.context().cookies();
      const csrfCookie = cookies.find(c =>
        /^(calypso[-_]?csrf[-_]?token|csrf[-_]?token)$/i.test(c.name),
      );
      if (!csrfCookie) {
        console.warn(
          `[ats] Workday Playwright ${tenant}: no CSRF cookie found ` +
          `(saw: ${cookies.map(c => c.name).join(',') || '<none>'})`,
        );
        csrfFailedSlugs.push(tenant);
        return;
      }

      // page.request shares cookies with the browser context, so the CSRF cookie
      // is sent automatically; we just need to mirror its value in the header.
      const response = await page.request.post(`https://${baseHost}${apiPath}`, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Calypso-Csrf-Token': csrfCookie.value,
        },
        data: { appliedFacets: {}, limit: 20, offset: 0, searchText: 'intern' },
      });
      if (!response.ok()) {
        console.warn(`[ats] Workday Playwright ${tenant}: API HTTP ${response.status()}`);
        csrfFailedSlugs.push(tenant);
        return;
      }
      const data: any = await response.json();
      if (!data) {
        console.warn(`[ats] Workday Playwright ${tenant}: empty body`);
        csrfFailedSlugs.push(tenant);
        return;
      }
      // API call worked — CSRF path confirmed for this tenant
      csrfConfirmedSlugs.push(tenant);

      const postings: any[] = data.jobPostings || [];
      const company = target.name || tenant;
      const interns = postings.filter((j) => isInternTitle(j.title || ''));

      // Fetch descriptions via the same authenticated page.request (re-uses
      // CSRF cookie). Concurrent cap of 5 to keep tenant cost bounded.
      const descriptions = new Map<string, string>();
      await pool(interns, 5, async (j) => {
        try {
          const r = await page.request.get(
            `https://${baseHost}/wday/cxs/${tenant}/${board}${j.externalPath}`,
            { headers: { 'Accept': 'application/json', 'X-Calypso-Csrf-Token': csrfCookie.value } },
          );
          if (r.ok()) {
            const d: any = await r.json();
            const raw = d?.jobPostingInfo?.jobDescription || '';
            descriptions.set(j.externalPath, stripHtml(raw).slice(0, MAX_RAW_DESC));
          }
        } catch { /* leave description empty */ }
      });

      const tJobs = interns.map((j) => {
        const rawLoc = j.locationsText || '';
        const location = (rawLoc && rawLoc !== company) ? rawLoc : 'United States';
        return buildInternshipRow({
          title: j.title || '',
          company,
          location,
          link: `${boardUrl}${j.externalPath}`,
          source: 'Workday',
          seenAt: now,
          description: descriptions.get(j.externalPath),
        });
      });
      if (tJobs.length > 0) {
        console.log(`[ats] ${company} (Workday/Playwright): ${tJobs.length} internships`);
      }
      jobs.push(...tJobs);
    } catch (e: any) {
      console.warn(`[ats] Workday Playwright ${tenant}: ${e.message}`);
    } finally {
      await page.close();
    }
  }

  try {
    await pool(csrfTargets, CONCURRENCY, async (target) => {
      await pollOnePw(target);
    });
  } finally {
    await closeBrowserSafely(browser, 'workday-pw');
  }
  return { jobs, csrfConfirmedSlugs, csrfFailedSlugs };
}

// Sidecar cache for Workday runtime flags. ats-targets.json stays as pure
// curation — the volatile wdCsrfRequired / wdSkipPlaywright flags live here
// and are gitignored so cycle churn doesn't pollute git status. Read on each
// pollATS call and overlaid onto the in-memory target list.
interface WorkdayFlagsCache {
  [slug: string]: {
    wdCsrfRequired?: boolean;
    wdSkipPlaywright?: boolean;
    wdInternFacets?: { [facetParameter: string]: string[] };
  };
}

const workdayFlagsStore = jsonStore<WorkdayFlagsCache>('workday-flags-cache.json', {});

function cacheWorkdayFlags(
  confirmed: string[],
  failed: string[],
  facetDiscoveries?: Map<string, { [k: string]: string[] }>,
): void {
  const facetCount = facetDiscoveries?.size ?? 0;
  if (confirmed.length === 0 && failed.length === 0 && facetCount === 0) return;
  try {
    const cache = workdayFlagsStore.load();
    let confirmedCount = 0;
    let failedCount = 0;
    let withFacets = 0;
    let withoutFacets = 0;
    for (const slug of confirmed) {
      if (!cache[slug]) cache[slug] = {};
      if (!cache[slug].wdCsrfRequired) { cache[slug].wdCsrfRequired = true; confirmedCount++; }
    }
    for (const slug of failed) {
      if (!cache[slug]) cache[slug] = {};
      if (!cache[slug].wdSkipPlaywright) { cache[slug].wdSkipPlaywright = true; failedCount++; }
    }
    if (facetDiscoveries) {
      for (const [slug, facets] of facetDiscoveries) {
        if (!cache[slug]) cache[slug] = {};
        cache[slug].wdInternFacets = facets;
        if (Object.keys(facets).length > 0) withFacets++;
        else withoutFacets++;
      }
    }
    workdayFlagsStore.save(cache);
    const parts = [];
    if (confirmedCount > 0)  parts.push(`${confirmedCount} wdCsrfRequired`);
    if (failedCount > 0)     parts.push(`${failedCount} wdSkipPlaywright`);
    if (withFacets > 0)      parts.push(`${withFacets} wdInternFacets`);
    if (withoutFacets > 0)   parts.push(`${withoutFacets} wdInternFacets(empty)`);
    if (parts.length > 0) {
      console.log(`[ats] Cached Workday flags (sidecar) for ${parts.join(', ')} tenant(s)`);
    }
  } catch (e: any) {
    console.warn(`[ats] Failed to cache Workday flags: ${e.message}`);
  }
}

function overlayWorkdayFlags(targets: ATSTarget[]): ATSTarget[] {
  const cache = workdayFlagsStore.load();
  if (Object.keys(cache).length === 0) return targets;
  return targets.map((t) => {
    if (t.ats !== 'workday') return t;
    const cached = cache[t.slug];
    if (!cached) return t;
    // Cache wins over file: once a runtime probe has classified a tenant,
    // that's the freshest signal. File values are retained as initial seed.
    return {
      ...t,
      wdCsrfRequired: cached.wdCsrfRequired ?? t.wdCsrfRequired,
      wdSkipPlaywright: cached.wdSkipPlaywright ?? t.wdSkipPlaywright,
      wdInternFacets: cached.wdInternFacets ?? t.wdInternFacets,
    };
  });
}

export async function pollATS(): Promise<Partial<Internship>[]> {
  const rawTargets = loadATSTargets();
  if (rawTargets.length === 0) {
    console.warn('[ats] No targets in data/ats-targets.json (file missing, malformed, or empty)');
    return [];
  }
  const targets: ATSTarget[] = overlayWorkdayFlags(rawTargets);
  const now = new Date().toISOString();
  const results: Partial<Internship>[] = [];

  // Separate Playwright-required Workday targets to batch browser startup.
  // Tenants flagged wdSkipPlaywright have already failed the Playwright path
  // (no CSRF cookie or repeated API rejects) — keep them out of both queues
  // so we don't burn ~5s/cycle re-attempting forever.
  const csrfTargets = targets.filter(
    t => t.ats === 'workday' && t.wdCsrfRequired && !t.wdSkipPlaywright,
  );
  const regularTargets = targets.filter(
    t => !(t.ats === 'workday' && t.wdCsrfRequired) && !(t.ats === 'workday' && t.wdSkipPlaywright),
  );
  // Workday targets that 422 in the direct CXS call get queued here for the
  // Playwright/CSRF fallback (and cached as wdCsrfRequired after first success).
  const csrfFallback: ATSTarget[] = [];
  // Workday targets whose intern-facet IDs were discovered this cycle.
  // Flushed to the sidecar cache at the end of pollATS so subsequent cycles
  // skip the discovery call and go straight to the filtered query.
  const facetDiscoveries = new Map<string, { [k: string]: string[] }>();

  // Worker pool — N targets processed in parallel. Network-bound work, so
  // ramping concurrency well above CPU count is fine. Per-host load stays
  // reasonable in practice because targets are spread across many ATS hosts.
  const CONCURRENCY = parseInt(process.env.ATS_POLL_CONCURRENCY || '8', 10);

  async function pollOne(target: ATSTarget): Promise<void> {
    try {
      let jobs: Partial<Internship>[] = [];
      if (target.ats === 'greenhouse') jobs = await pollGreenhouse(target, now);
      else if (target.ats === 'lever') jobs = await pollLever(target, now);
      else if (target.ats === 'ashby') jobs = await pollAshby(target, now);
      else if (target.ats === 'workday') jobs = await pollWorkday(target, now, facetDiscoveries);
      else if (target.ats === 'icims') jobs = await pollICIMS(target, now);
      else if (target.ats === 'smartrecruiters') jobs = await pollSmartRecruiters(target, now);
      else if (target.ats === 'rippling') jobs = await pollRippling(target, now);
      else if (target.ats === 'workable') jobs = await pollWorkable(target, now);
      if (jobs.length > 0) {
        console.log(`[ats] ${target.name || target.slug}: ${jobs.length} internships`);
        results.push(...jobs);
      }
    } catch (e: any) {
      const status = e?.response?.status;
      // Workday tenants that 422 here have CSRF enforcement enabled — try Playwright
      // fallback, unless we've already cached a wdSkipPlaywright:true (the tenant
      // has consistently failed the Playwright path too, so retrying wastes ~5s/cycle).
      if (target.ats === 'workday' && status === 422 && !target.wdSkipPlaywright) {
        csrfFallback.push(target);
        return;
      }
      const msg = status ? `HTTP ${status}` : e.message;
      console.warn(`[ats] ${target.name || target.slug} (${target.ats}): ${msg}`);
    }
  }

  await pool(regularTargets, CONCURRENCY, async (target) => {
    await pollOne(target);
  });

  // Playwright batch for CSRF-protected Workday instances (pre-flagged + newly-detected 422 fallbacks)
  const allCsrfTargets = [...csrfTargets, ...csrfFallback];
  if (allCsrfTargets.length > 0) {
    if (csrfFallback.length > 0) {
      console.log(`[ats] Workday: ${csrfFallback.length} target(s) returned HTTP 422 — queuing for Playwright fallback`);
    }
    try {
      const { jobs: playwrightJobs, csrfConfirmedSlugs, csrfFailedSlugs } = await pollWorkdayPlaywright(allCsrfTargets, now);
      results.push(...playwrightJobs);
      console.log(`[ats] Workday/Playwright total: ${playwrightJobs.length} from ${allCsrfTargets.length} targets`);
      cacheWorkdayFlags(csrfConfirmedSlugs, csrfFailedSlugs, facetDiscoveries);
    } catch (e: any) {
      console.warn(`[ats] Workday/Playwright batch failed: ${e.message}`);
    }
  } else if (facetDiscoveries.size > 0) {
    // No CSRF batch but we still discovered facets via the direct path.
    cacheWorkdayFlags([], [], facetDiscoveries);
  }

  console.log(`[ats] Total: ${results.length} internships from ${targets.length} targets`);
  return results;
}
