import axios from 'axios';
import type { RawPosting, ATSTarget } from '../../lib/types';
import { loadATSTargets } from '../../lib/utils/ats-discovery';
import { isInternTitle } from '../utils/intern-signal';
import { stripHtml } from '../utils/html';
import {
  extractLeverDescription,
  fetchSmartRecruitersDescription,
  fetchRipplingDescription,
} from '../utils/description-fetchers';
import { buildPosting } from '../utils/build-row';
import { pool } from '../../lib/concurrency';
import { listedCompanyTier } from '../../lib/scorer';
import { getPromotedCompanyKeys } from '../../lib/store';
import { companyKey } from '../../lib/company-key';
import { canonicalizeCompany } from '../../lib/canonicalize-company';
import { stripEmojiPrefix } from '../../lib/utils/normalize';
import {
  pollWorkdayDirect, pollWorkdayViaPlaywright, overlayWorkdayFlags, saveWorkdayFlags,
  WorkdayHttpError, type InternFacets,
} from './workday';

const REQUEST_TIMEOUT = 10_000;
const HTML_HEADERS = { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' };
const JSON_HEADERS = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };

type Adapter = (target: ATSTarget, now: string) => Promise<RawPosting[]>;

// ---------------------------------------------------------------------------
// Greenhouse
// ---------------------------------------------------------------------------

interface GreenhouseJob {
  id: number;
  title?: string;
  absolute_url?: string;
  updated_at?: string;
  content?: string;
  location?: { name?: string };
}

const pollGreenhouse: Adapter = async (target, now) => {
  const { data } = await axios.get<{ jobs?: GreenhouseJob[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${target.slug}/jobs?content=true`,
    { timeout: REQUEST_TIMEOUT },
  );
  const company = target.name || target.slug;
  return (data.jobs ?? [])
    .filter(j => isInternTitle(j.title ?? ''))
    .map(j => buildPosting({
      title: stripHtml(j.title ?? ''),
      company,
      locations: (j.location?.name ?? '').split(';'),
      link: j.absolute_url || `https://boards.greenhouse.io/${target.slug}/jobs/${j.id}`,
      source: 'Greenhouse',
      upstreamPostedAt: j.updated_at,
      now,
      descriptionHtml: j.content,
    }));
};

// ---------------------------------------------------------------------------
// Lever
// ---------------------------------------------------------------------------

interface LeverPosting {
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  categories?: { commitment?: string; location?: string };
  descriptionPlain?: string;
  description?: string;
  lists?: Array<{ text?: string; content?: string }>;
}

const pollLever: Adapter = async (target, now) => {
  const { data } = await axios.get<LeverPosting[]>(`https://api.lever.co/v0/postings/${target.slug}?mode=json`, { timeout: REQUEST_TIMEOUT });
  const company = target.name || target.slug;
  return (Array.isArray(data) ? data : [])
    .filter(j => isInternTitle(j.text ?? '') || (j.categories?.commitment ?? '').toLowerCase() === 'internship')
    .map(j => buildPosting({
      title: j.text ?? '',
      company,
      // workplaceType is an enum (remote/onsite/hybrid); only "remote" is a place.
      location: j.categories?.location || (String(j.workplaceType).toLowerCase() === 'remote' ? 'Remote' : ''),
      link: j.hostedUrl || j.applyUrl || '',
      source: 'Lever',
      upstreamPostedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
      now,
      description: extractLeverDescription(j),
    }));
};

// ---------------------------------------------------------------------------
// Ashby (public posting API; one call returns every job with its description)
// ---------------------------------------------------------------------------

interface AshbyJob {
  id: string;
  title: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  isRemote?: boolean | null;
  publishedAt?: string;
  jobUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
}

const ashbyBoardApi = (slug: string) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`;

const pollAshby: Adapter = async (target, now) => {
  const { data } = await axios.get<{ jobs?: AshbyJob[] }>(ashbyBoardApi(target.slug), { timeout: REQUEST_TIMEOUT, headers: JSON_HEADERS });
  const company = target.name || target.slug;
  return (data.jobs ?? [])
    .filter(j => isInternTitle(j.title ?? '') || /intern/i.test(j.employmentType ?? ''))
    .map(j => buildPosting({
      title: j.title ?? '',
      company,
      locations: [j.location, ...(j.secondaryLocations ?? []).map(l => l.location), j.isRemote ? 'Remote' : undefined],
      link: j.jobUrl || `https://jobs.ashbyhq.com/${target.slug}/${j.id}`,
      source: 'Ashby',
      upstreamPostedAt: j.publishedAt,
      now,
      description: j.descriptionPlain,
      descriptionHtml: j.descriptionPlain ? undefined : j.descriptionHtml,
    }));
};

// ---------------------------------------------------------------------------
// iCIMS (HTML only; no location or description on the list page)
// ---------------------------------------------------------------------------

const pollICIMS: Adapter = async (target, now) => {
  const tenantId = target.slug;
  const { data: html } = await axios.get<string>(
    `https://careers-${tenantId}.icims.com/jobs/search?ss=1&searchKeyword=intern&searchLocation=&in_iframe=1`,
    { timeout: REQUEST_TIMEOUT, headers: HTML_HEADERS, responseType: 'text' },
  );
  const company = target.name || tenantId;
  const results: RawPosting[] = [];
  const itemPattern = /<li[^>]*class="[^"]*iCIMS_JobsTable_Item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  const linkPattern = /href="([^"]*\/jobs\/(\d+)\/[^"]*)"[^>]*>\s*(.*?)\s*<\/a>/i;
  for (const item of html.matchAll(itemPattern)) {
    const link = linkPattern.exec(item[1]);
    if (!link) continue;
    const [, relLink, jobId, rawTitle] = link;
    const title = rawTitle.replace(/<[^>]+>/g, '').trim();
    if (!isInternTitle(title)) continue;
    results.push(buildPosting({
      title,
      company,
      location: 'United States',
      link: relLink.startsWith('http') ? relLink : `https://careers-${tenantId}.icims.com/jobs/${jobId}/job`,
      source: 'iCIMS',
      now,
    }));
  }
  return results;
};

// ---------------------------------------------------------------------------
// SmartRecruiters
// ---------------------------------------------------------------------------

interface SmartRecruitersPosting {
  id: string;
  name?: string;
  releasedDate?: string;
  typeOfEmployment?: { id?: string };
  location?: { city?: string; region?: string; country?: string };
}

const pollSmartRecruiters: Adapter = async (target, now) => {
  const { data } = await axios.get<{ content?: SmartRecruitersPosting[] }>(
    `https://api.smartrecruiters.com/v1/companies/${target.slug}/postings?status=PUBLIC&limit=100`,
    { timeout: REQUEST_TIMEOUT, headers: JSON_HEADERS },
  );
  const company = target.name || target.slug;
  const interns = (data.content ?? []).filter(j => isInternTitle(j.name ?? '') || /intern/i.test(j.typeOfEmployment?.id ?? ''));
  const results: RawPosting[] = [];
  for (const j of interns) {
    results.push(buildPosting({
      title: j.name ?? '',
      company,
      location: [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(', ') || 'United States',
      link: `https://jobs.smartrecruiters.com/${target.slug}/${j.id}`,
      source: 'SmartRecruiters',
      upstreamPostedAt: j.releasedDate,
      now,
      description: await fetchSmartRecruitersDescription(target.slug, j.id),
    }));
  }
  return results;
};

// ---------------------------------------------------------------------------
// Rippling (one entry per location sharing a uuid; grouped into one row)
// ---------------------------------------------------------------------------

interface RipplingJob {
  uuid: string;
  name?: string;
  url?: string;
  workLocation?: { label?: string };
}

const pollRippling: Adapter = async (target, now) => {
  const { data } = await axios.get<RipplingJob[]>(`https://api.rippling.com/platform/api/ats/v1/board/${target.slug}/jobs`, {
    timeout: REQUEST_TIMEOUT, headers: JSON_HEADERS,
  });
  const company = target.name || target.slug;
  const byUuid = new Map<string, { job: RipplingJob; locations: string[] }>();
  for (const j of Array.isArray(data) ? data : []) {
    if (!isInternTitle(j.name ?? '')) continue;
    const loc = j.workLocation?.label;
    const entry = byUuid.get(j.uuid) ?? { job: j, locations: [] };
    if (loc && !entry.locations.includes(loc)) entry.locations.push(loc);
    byUuid.set(j.uuid, entry);
  }
  const grouped = [...byUuid.values()];
  const descriptions = new Map<string, string>();
  await pool(grouped, 5, async ({ job }) => {
    descriptions.set(job.uuid, await fetchRipplingDescription(target.slug, job.uuid));
  });
  return grouped.map(({ job, locations }) => buildPosting({
    title: job.name ?? '',
    company,
    locations,
    link: job.url || `https://ats.rippling.com/${target.slug}/jobs/${job.uuid}`,
    source: 'Rippling',
    now,
    description: descriptions.get(job.uuid),
  }));
};

// ---------------------------------------------------------------------------
// Workable (title-only match; `type` is "temporary" for interns and contractors alike)
// ---------------------------------------------------------------------------

interface WorkableJob {
  shortcode: string;
  title?: string;
  published?: string;
  remote?: boolean;
  workplace?: string;
  location?: { city?: string; region?: string; country?: string };
}

const pollWorkable: Adapter = async (target, now) => {
  const { data } = await axios.post<{ results?: WorkableJob[] }>(`https://apply.workable.com/api/v3/accounts/${target.slug}/jobs`, {}, {
    timeout: REQUEST_TIMEOUT, headers: { 'Content-Type': 'application/json', ...JSON_HEADERS },
  });
  const company = target.name || target.slug;
  return (data.results ?? [])
    .filter(j => isInternTitle(j.title ?? ''))
    .map(j => {
      const loc = j.location ?? {};
      const isRemote = j.remote === true || String(j.workplace).toLowerCase() === 'remote';
      return buildPosting({
        title: j.title ?? '',
        company,
        location: loc.city ? [loc.city, loc.region, loc.country].filter(Boolean).join(', ') : (isRemote ? 'Remote' : loc.country ?? ''),
        link: `https://apply.workable.com/${target.slug}/j/${j.shortcode}/`,
        source: 'Workable',
        upstreamPostedAt: j.published,
        now,
      });
    });
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const ADAPTERS: Record<Exclude<ATSTarget['ats'], 'workday'>, Adapter> = {
  greenhouse: pollGreenhouse,
  lever: pollLever,
  ashby: pollAshby,
  icims: pollICIMS,
  smartrecruiters: pollSmartRecruiters,
  rippling: pollRippling,
  workable: pollWorkable,
};

// Startups hire through Ashby, Greenhouse, and Lever; the enterprise ATSes
// are dominated by employers nobody curated. Poll those only for companies
// in the scoring tiers or judged elite/top/hot by the classifier.
const CURATED_ONLY_ATS = new Set<ATSTarget['ats']>(['workday', 'icims', 'smartrecruiters']);

export function shouldPoll(target: ATSTarget, promoted: Set<string> = new Set()): boolean {
  if (!CURATED_ONLY_ATS.has(target.ats)) return true;
  const name = target.name || target.slug;
  return listedCompanyTier(name) !== null || promoted.has(companyKey(canonicalizeCompany(stripEmojiPrefix(name))));
}

export async function pollATS(): Promise<RawPosting[]> {
  const all = overlayWorkdayFlags(loadATSTargets());
  const promoted = await getPromotedCompanyKeys().catch(() => new Set<string>());
  const targets = all.filter(t => shouldPoll(t, promoted));
  if (targets.length === 0) {
    console.warn('[ats] No targets in data/ats-targets.json');
    return [];
  }
  if (targets.length < all.length) console.log(`[ats] Skipping ${all.length - targets.length} uncurated Workday/iCIMS/SmartRecruiters tenants`);
  const now = new Date().toISOString();
  const results: RawPosting[] = [];
  const discoveredFacets = new Map<string, InternFacets>();
  // Workday tenants that need the CSRF path: flagged from earlier cycles, plus
  // any that 422 this cycle. Tenants where Playwright has already failed are
  // skipped entirely rather than retried every hour.
  const csrfQueue = targets.filter(t => t.ats === 'workday' && t.wdCsrfRequired && !t.wdSkipPlaywright);
  const direct = targets.filter(t => !(t.ats === 'workday' && (t.wdCsrfRequired || t.wdSkipPlaywright)));

  const CONCURRENCY = parseInt(process.env.ATS_POLL_CONCURRENCY || '8', 10);
  await pool(direct, CONCURRENCY, async (target) => {
    const label = `${target.name || target.slug} (${target.ats})`;
    try {
      let jobs: RawPosting[];
      if (target.ats === 'workday') {
        const r = await pollWorkdayDirect(target, now);
        if (r.discoveredFacets) discoveredFacets.set(target.slug, r.discoveredFacets);
        jobs = r.postings;
      } else {
        jobs = await ADAPTERS[target.ats](target, now);
      }
      if (jobs.length > 0) {
        console.log(`[ats] ${label}: ${jobs.length} internships`);
        results.push(...jobs);
      }
    } catch (e) {
      if (e instanceof WorkdayHttpError && e.status === 422) {
        csrfQueue.push(target);
        return;
      }
      const status = axios.isAxiosError(e) ? e.response?.status : e instanceof WorkdayHttpError ? e.status : undefined;
      console.warn(`[ats] ${label}: ${status ? `HTTP ${status}` : e instanceof Error ? e.message : e}`);
    }
  });

  if (csrfQueue.length > 0) {
    console.log(`[ats] Workday: ${csrfQueue.length} tenant(s) need the CSRF path`);
    try {
      const pw = await pollWorkdayViaPlaywright(csrfQueue, now);
      results.push(...pw.postings);
      for (const [slug, f] of pw.discoveredFacets) discoveredFacets.set(slug, f);
      console.log(`[ats] Workday/Playwright: ${pw.postings.length} internships from ${csrfQueue.length} tenants`);
      saveWorkdayFlags({ confirmed: pw.confirmed, failed: pw.failed, facets: discoveredFacets });
    } catch (e) {
      console.warn(`[ats] Workday/Playwright batch failed: ${e instanceof Error ? e.message : e}`);
    }
  } else if (discoveredFacets.size > 0) {
    saveWorkdayFlags({ facets: discoveredFacets });
  }

  console.log(`[ats] Total: ${results.length} internships from ${targets.length} targets`);
  return results;
}
