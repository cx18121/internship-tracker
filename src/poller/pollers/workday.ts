import axios from 'axios';
import type { Page } from 'playwright';
import type { RawPosting, ATSTarget } from '../../lib/types';
import { isInternTitle } from '../utils/intern-signal';
import { stripHtml } from '../utils/html';
import { buildPosting } from '../utils/build-row';
import { pool } from '../../lib/concurrency';
import { jsonStore } from '../../lib/sidecar';
import { closeBrowserSafely } from '../utils/browser';

// Workday exposes one JSON API (CXS) per tenant. Most tenants accept plain
// HTTP; some enforce a CSRF cookie that only a real page load provisions, so
// those run through a Playwright page. Both paths use the same WorkdayClient.

const REQUEST_TIMEOUT = 10_000;
const WD_PAGE = 20;
const WD_MAX_POSTINGS = 2000;
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };

export type InternFacets = { [facetParameter: string]: string[] };

interface WorkdayJobsResponse {
  total?: number;
  jobPostings?: WorkdayPosting[];
  facets?: Array<{ facetParameter?: string; values?: Array<{ id: string; descriptor: string }> }>;
}
interface WorkdayPosting {
  title?: string;
  externalPath: string;
  locationsText?: string;
}
interface WorkdayDetailResponse {
  jobPostingInfo?: { jobDescription?: string; location?: string; additionalLocations?: string[]; /** Post date, YYYY-MM-DD. */ startDate?: string };
}

export interface WorkdayClient {
  post(path: string, body: object): Promise<WorkdayJobsResponse>;
  get(path: string): Promise<WorkdayDetailResponse>;
}

/** Thrown by a client when the tenant rejects the request for a known reason. */
export class WorkdayHttpError extends Error {
  constructor(public status: number) {
    super(`Workday HTTP ${status}`);
  }
}

interface Tenant {
  tenant: string;
  board: string;
  baseHost: string;
  boardUrl: string;
  apiBase: string;
  company: string;
}

function describeTenant(target: ATSTarget): Tenant {
  const tenant = target.slug;
  const board = target.board || '';
  const wdInstance = target.wdInstance || 'wd1';
  const isSiteVariant = target.wdDomain === 'myworkdaysite.com';
  const baseHost = isSiteVariant ? `${wdInstance}.myworkdaysite.com` : `${tenant}.${wdInstance}.myworkdayjobs.com`;
  return {
    tenant,
    board,
    baseHost,
    boardUrl: workdayBoardUrl(baseHost, tenant, board, isSiteVariant),
    apiBase: `https://${baseHost}/wday/cxs/${tenant}/${board}`,
    company: target.name || tenant,
  };
}

// Public job URLs are rooted at the board, not the host: externalPath ("/job/…")
// is relative to it. Site-variant boards additionally sit under /recruiting/.
export function workdayBoardUrl(baseHost: string, tenant: string, board: string, isSiteVariant: boolean): string {
  return isSiteVariant ? `https://${baseHost}/recruiting/${tenant}/${board}` : `https://${baseHost}/${board}`;
}

function directClient(t: Tenant): WorkdayClient {
  const wrap = async <T>(p: Promise<{ data: T }>): Promise<T> => {
    try {
      return (await p).data;
    } catch (e) {
      if (axios.isAxiosError(e) && e.response) throw new WorkdayHttpError(e.response.status);
      throw e;
    }
  };
  return {
    post: (path, body) => wrap(axios.post<WorkdayJobsResponse>(`${t.apiBase}${path}`, body, { timeout: REQUEST_TIMEOUT, headers: JSON_HEADERS })),
    get: (path) => wrap(axios.get<WorkdayDetailResponse>(`${t.apiBase}${path}`, { timeout: REQUEST_TIMEOUT, headers: JSON_HEADERS })),
  };
}

function playwrightClient(t: Tenant, page: Page, csrfToken: string): WorkdayClient {
  const headers = { ...JSON_HEADERS, 'X-Calypso-Csrf-Token': csrfToken };
  const check = async <T>(r: import('playwright').APIResponse): Promise<T> => {
    if (!r.ok()) throw new WorkdayHttpError(r.status());
    return (await r.json()) as T;
  };
  return {
    post: (path, body) => page.request.post(`${t.apiBase}${path}`, { headers, data: body }).then(r => check<WorkdayJobsResponse>(r)),
    get: (path) => page.request.get(`${t.apiBase}${path}`, { headers }).then(r => check<WorkdayDetailResponse>(r)),
  };
}

// Facets that categorize roles as interns or co-ops. Filtering server-side by
// facet keeps large tenants under the scan budget. An empty result means the
// tenant has no such facet and every posting must be scanned.
const FACET_PARAMS_WITH_INTERN_BUCKETS = ['jobFamilyGroup', 'workerSubType'];
const INTERN_DESCRIPTOR_RE = /\bintern(s|ship|ships)?\b|\bco-?op\b/i;

export function extractInternFacets(response: WorkdayJobsResponse): InternFacets {
  const result: InternFacets = {};
  for (const facet of response.facets ?? []) {
    if (!facet.facetParameter || !FACET_PARAMS_WITH_INTERN_BUCKETS.includes(facet.facetParameter)) continue;
    const matched = (facet.values ?? []).filter(v => INTERN_DESCRIPTOR_RE.test(v.descriptor));
    if (matched.length > 0) result[facet.facetParameter] = matched.map(v => v.id);
  }
  return result;
}

export interface TenantPollResult {
  postings: RawPosting[];
  /** Set when facet discovery ran this call, so the caller can cache it. */
  discoveredFacets?: InternFacets;
}

async function pollTenant(target: ATSTarget, client: WorkdayClient, now: string): Promise<TenantPollResult> {
  const t = describeTenant(target);
  const result: TenantPollResult = { postings: [] };

  const discoverFacets = async (): Promise<InternFacets> => {
    const facets = extractInternFacets(await client.post('/jobs', { appliedFacets: {}, limit: 1, offset: 0, searchText: '' }));
    result.discoveredFacets = facets;
    return facets;
  };

  const fetchAll = async (appliedFacets: InternFacets): Promise<WorkdayPosting[]> => {
    const all: WorkdayPosting[] = [];
    for (let offset = 0; offset < WD_MAX_POSTINGS; offset += WD_PAGE) {
      const data = await client.post('/jobs', { appliedFacets, limit: WD_PAGE, offset, searchText: '' });
      const total = data.total ?? null;
      if (offset === 0 && total != null && total > WD_MAX_POSTINGS) {
        console.warn(`[ats] ${t.company} (workday): ${total} postings exceeds the ${WD_MAX_POSTINGS} scan budget with no intern facet; skipping`);
        return [];
      }
      const batch = data.jobPostings ?? [];
      all.push(...batch);
      if (batch.length < WD_PAGE || (total != null && all.length >= total)) return all;
    }
    console.warn(`[ats] ${t.company} (workday): hit ${WD_MAX_POSTINGS}-posting cap without a total; results may be incomplete`);
    return all;
  };

  let facets = target.wdInternFacets ?? await discoverFacets();
  let postings: WorkdayPosting[];
  try {
    postings = await fetchAll(facets);
  } catch (e) {
    // A 400 means the cached facet ids are stale; rediscover once.
    if (!(e instanceof WorkdayHttpError && e.status === 400)) throw e;
    facets = await discoverFacets();
    postings = await fetchAll(facets);
  }
  const interns = postings.filter(j => isInternTitle(j.title || ''));

  // The list endpoint gives a count ("2 Locations") or a campus name; the
  // detail endpoint has the description and the real location list.
  const details = new Map<string, WorkdayDetailResponse['jobPostingInfo']>();
  await pool(interns, 5, async (j) => {
    const detail = await client.get(j.externalPath).catch(() => null);
    details.set(j.externalPath, detail?.jobPostingInfo);
  });

  result.postings = interns.map(j => {
    const info = details.get(j.externalPath);
    const listed = j.locationsText && !/^\d+ locations?$/i.test(j.locationsText) && j.locationsText !== t.company ? j.locationsText : '';
    const locations = info?.location ? [info.location, ...(info.additionalLocations ?? [])] : [listed || 'United States'];
    return buildPosting({
      title: j.title || '',
      company: t.company,
      locations,
      link: `${t.boardUrl}${j.externalPath}`,
      source: 'Workday',
      upstreamPostedAt: info?.startDate,
      now,
      description: stripHtml(info?.jobDescription ?? ''),
    });
  });
  return result;
}

/** Direct HTTP poll. Throws WorkdayHttpError(422) when the tenant needs the CSRF path. */
export function pollWorkdayDirect(target: ATSTarget, now: string): Promise<TenantPollResult> {
  return pollTenant(target, directClient(describeTenant(target)), now);
}

export interface PlaywrightBatchResult {
  postings: RawPosting[];
  confirmed: string[];
  failed: string[];
  discoveredFacets: Map<string, InternFacets>;
}

/** Poll CSRF-protected tenants through one shared Firefox instance. */
export async function pollWorkdayViaPlaywright(targets: ATSTarget[], now: string): Promise<PlaywrightBatchResult> {
  const out: PlaywrightBatchResult = { postings: [], confirmed: [], failed: [], discoveredFacets: new Map() };
  if (targets.length === 0) return out;

  const { firefox } = await import('playwright');
  const browser = await firefox.launch({ headless: true });
  const CONCURRENCY = parseInt(process.env.WORKDAY_PLAYWRIGHT_CONCURRENCY || '4', 10);

  async function pollOne(target: ATSTarget): Promise<void> {
    const t = describeTenant(target);
    if (!t.board) {
      console.warn(`[ats] Workday Playwright ${t.tenant}: no board name configured; skipping`);
      return;
    }
    const page = await browser.newPage();
    try {
      await page.goto(t.boardUrl, { waitUntil: 'networkidle', timeout: 30_000 });
      // The CSRF cookie is HttpOnly, so it is only visible from the context.
      const cookies = await page.context().cookies();
      const csrf = cookies.find(c => /^(calypso[-_]?csrf[-_]?token|csrf[-_]?token)$/i.test(c.name));
      if (!csrf) {
        console.warn(`[ats] Workday Playwright ${t.tenant}: no CSRF cookie (saw: ${cookies.map(c => c.name).join(',') || '<none>'})`);
        out.failed.push(t.tenant);
        return;
      }
      const result = await pollTenant(target, playwrightClient(t, page, csrf.value), now);
      out.confirmed.push(t.tenant);
      out.postings.push(...result.postings);
      if (result.discoveredFacets) out.discoveredFacets.set(t.tenant, result.discoveredFacets);
      if (result.postings.length > 0) console.log(`[ats] ${t.company} (Workday/Playwright): ${result.postings.length} internships`);
    } catch (e) {
      console.warn(`[ats] Workday Playwright ${t.tenant}: ${e instanceof Error ? e.message : e}`);
      out.failed.push(t.tenant);
    } finally {
      await page.close();
    }
  }

  try {
    await pool(targets, CONCURRENCY, pollOne);
  } finally {
    await closeBrowserSafely(browser, 'workday-pw');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runtime flags learned per tenant (CSRF required, Playwright confirmed
// failing, discovered facet ids). Kept out of ats-targets.json so cycle
// churn doesn't touch the curated file.
// ---------------------------------------------------------------------------

type WorkdayFlags = Pick<ATSTarget, 'wdCsrfRequired' | 'wdSkipPlaywright' | 'wdInternFacets'>;
const flagsStore = jsonStore<Record<string, WorkdayFlags>>('workday-flags-cache.json', {});

export function overlayWorkdayFlags(targets: ATSTarget[]): ATSTarget[] {
  const cache = flagsStore.load();
  return targets.map(t => (t.ats === 'workday' && cache[t.slug] ? { ...t, ...cache[t.slug] } : t));
}

export function saveWorkdayFlags(update: { confirmed?: string[]; failed?: string[]; facets?: Map<string, InternFacets> }): void {
  const cache = flagsStore.load();
  for (const slug of update.confirmed ?? []) cache[slug] = { ...cache[slug], wdCsrfRequired: true };
  for (const slug of update.failed ?? []) cache[slug] = { ...cache[slug], wdSkipPlaywright: true };
  for (const [slug, facets] of update.facets ?? []) cache[slug] = { ...cache[slug], wdInternFacets: facets };
  flagsStore.save(cache);
}
