import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Internship } from '../../lib/types';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'ats-targets.json');
const REQUEST_TIMEOUT = 10_000;

export interface ATSTarget {
  slug: string;
  ats: 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'icims' | 'smartrecruiters';
  name?: string;
  board?: string;            // Workday: job board path (e.g. 'NVIDIAExternalCareerSite')
  wdInstance?: string;       // Workday: wd1 (default), wd3, wd5, etc.
  wdDomain?: string;         // Workday: 'myworkdaysite.com' for site variant, default 'myworkdayjobs.com'
  wdCsrfRequired?: boolean;  // Workday: true when direct CXS API returns 422 (needs Playwright)
  wdSkipPlaywright?: boolean; // Workday: true when Playwright fallback has confirmed-failed (no CSRF cookie or API rejects); short-circuits future cycles to avoid ~5s of Playwright overhead per tenant per cycle
}

export function isInternTitle(title: string): boolean {
  return /\bintern(ship)?\b/i.test(title);
}

function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function pollGreenhouse(target: ATSTarget, now: string): Promise<Partial<Internship>[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${target.slug}/jobs?content=true`;
  const { data } = await axios.get(url, { timeout: REQUEST_TIMEOUT });
  const company = target.name || target.slug;
  return (data.jobs || [])
    .filter((j: any) => /\bintern(ship)?\b/i.test(j.title || ''))
    .map((j: any) => ({
      title: j.title || '',
      company,
      location: j.location?.name || null,
      description: stripHtml(j.content || '').slice(0, 4000) || undefined,
      link: j.absolute_url || `https://boards.greenhouse.io/${target.slug}/jobs/${j.id}`,
      source: 'Greenhouse',
      postedAt: j.updated_at || now,
      seenAt: now,
      applied: false,
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
    .map((j) => {
      const desc = j.descriptionPlain
        ? j.descriptionPlain
        : [
            stripHtml(j.description || ''),
            ...(j.lists ?? []).map((l: any) =>
              `${l.text ?? ''} ${stripHtml(l.content ?? '')}`,
            ),
          ].join(' ').replace(/\s+/g, ' ').trim();
      return {
        title: j.text || '',
        company,
        location: j.categories?.location || j.workplaceType || null,
        description: desc ? desc.slice(0, 4000) : undefined,
        link: j.hostedUrl || j.applyUrl || '',
        source: 'Lever',
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : now,
        seenAt: now,
        applied: false,
      };
    });
}

async function fetchAshbyDescription(slug: string, jobId: string): Promise<string> {
  try {
    const { data: html } = await axios.get(`https://jobs.ashbyhq.com/${slug}/${jobId}`, {
      timeout: REQUEST_TIMEOUT,
      headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' },
      responseType: 'text',
    });
    const m = (html as string).match(/window\.__appData\s*=\s*(\{.*?\});\s*\n/s);
    if (!m) return '';
    const data = JSON.parse(m[1]);
    // Detail page exposes the role directly at data.posting with descriptionHtml.
    // List page uses data.jobBoard.jobPostings[] but those entries DON'T include
    // descriptionHtml — only metadata. Kept as fallback for board-page calls.
    const posting = data?.posting
      ?? data?.jobBoard?.jobPostings?.find((p: any) => p.id === jobId)
      ?? data?.jobBoard?.jobPostings?.[0];
    return stripHtml(posting?.descriptionHtml ?? '').slice(0, 4000);
  } catch {
    return '';
  }
}

async function pollAshby(target: ATSTarget, now: string): Promise<Partial<Internship>[]> {
  // Ashby embeds job data in window.__appData on the job board page
  const { data: html } = await axios.get(`https://jobs.ashbyhq.com/${target.slug}`, {
    timeout: REQUEST_TIMEOUT,
    headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' },
    responseType: 'text',
  });

  const match = (html as string).match(/window\.__appData\s*=\s*(\{.*?\});\s*\n/s);
  if (!match) return [];

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
    const titleMatch = /\bintern(ship)?\b/i.test(j.title || '');
    const typeMatch = /\bintern(ship)?\b/i.test(j.employmentType || '');
    return titleMatch || typeMatch;
  });

  const results: Partial<Internship>[] = [];
  for (const j of interns) {
    const description = await fetchAshbyDescription(target.slug, j.id);
    results.push({
      title: j.title || '',
      company,
      location: j.workplaceType === 'Remote'
        ? 'Remote'
        : (j.locationName || j.locationExternalName || null),
      description: description || undefined,
      link: `https://jobs.ashbyhq.com/${target.slug}/${j.id}`,
      source: 'Ashby',
      postedAt: j.publishedDate || now,
      seenAt: now,
      applied: false,
    });
  }
  return results;
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
    return stripHtml(raw).slice(0, 4000);
  } catch {
    return '';
  }
}

async function pollWorkday(target: ATSTarget, now: string): Promise<Partial<Internship>[]> {
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
  const { data } = await axios.post(
    url,
    { appliedFacets: {}, limit: 20, offset: 0, searchText: 'intern' },
    {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    }
  );
  const postings: any[] = data.jobPostings || [];
  const company = target.name || target.slug;
  const interns = postings.filter((j) => isInternTitle(j.title || ''));

  // Concurrent description fetches (cap 5) so a tenant with 20 interns adds
  // ~12s instead of ~60s. Workday list endpoint doesn't include descriptions;
  // they're only on the per-job CXS detail call.
  const descriptions = new Map<string, string>();
  const queue = [...interns];
  await Promise.all(
    Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length > 0) {
        const j = queue.shift();
        if (!j) break;
        descriptions.set(j.externalPath, await fetchWorkdayDescription(baseHost, tenant, board, j.externalPath));
      }
    }),
  );

  return interns.map((j) => {
    // Workday sometimes returns a facility/campus name (e.g. "Hendrick Motorsports") as
    // locationsText rather than a city. If it just echoes the company name, fall back.
    const rawLoc = j.locationsText || '';
    const location = (rawLoc && rawLoc !== company) ? rawLoc : 'United States';
    const description = descriptions.get(j.externalPath) || undefined;
    return {
      title: j.title || '',
      company,
      location,
      description,
      link: `https://${baseHost}${j.externalPath}`,
      source: 'Workday',
      postedAt: now,
      seenAt: now,
      applied: false,
    };
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
    results.push({
      title,
      company,
      location: 'United States',
      link: relLink.startsWith('http')
        ? relLink
        : `https://careers-${tenantId}.icims.com/jobs/${jobId}/job`,
      source: 'iCIMS',
      postedAt: now,
      seenAt: now,
      applied: false,
    });
  }
  return results;
}

async function fetchSmartRecruitersDescription(slug: string, jobId: string): Promise<string> {
  try {
    const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${jobId}`;
    const { data } = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    const sections = data?.jobAd?.sections ?? {};
    const parts = [
      sections.companyDescription?.text,
      sections.jobDescription?.text,
      sections.qualifications?.text,
      sections.additionalInformation?.text,
    ].filter(Boolean);
    return stripHtml(parts.join(' ')).slice(0, 4000);
  } catch {
    return '';
  }
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
    results.push({
      title: j.name || '',
      company,
      location: [j.location?.city, j.location?.region, j.location?.country]
        .filter(Boolean).join(', ') || 'United States',
      description: description || undefined,
      link: `https://jobs.smartrecruiters.com/${target.slug}/${j.id}`,
      source: 'SmartRecruiters',
      postedAt: j.releasedDate || now,
      seenAt: now,
      applied: false,
    });
  }
  return results;
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
  const queue = [...csrfTargets];

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
    const boardUrl = isSiteVariant
      ? `https://${baseHost}/recruiting/${tenant}/${board}`
      : `https://${baseHost}/${board}`;
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
      const descQueue = [...interns];
      await Promise.all(
        Array.from({ length: Math.min(5, descQueue.length) }, async () => {
          while (descQueue.length > 0) {
            const j = descQueue.shift();
            if (!j) break;
            try {
              const r = await page.request.get(
                `https://${baseHost}/wday/cxs/${tenant}/${board}${j.externalPath}`,
                { headers: { 'Accept': 'application/json', 'X-Calypso-Csrf-Token': csrfCookie.value } },
              );
              if (r.ok()) {
                const d: any = await r.json();
                const raw = d?.jobPostingInfo?.jobDescription || '';
                descriptions.set(j.externalPath, stripHtml(raw).slice(0, 4000));
              }
            } catch { /* leave description empty */ }
          }
        }),
      );

      const tJobs = interns.map((j) => {
        const rawLoc = j.locationsText || '';
        const location = (rawLoc && rawLoc !== company) ? rawLoc : 'United States';
        return {
          title: j.title || '',
          company,
          location,
          description: descriptions.get(j.externalPath) || undefined,
          link: `https://${baseHost}${j.externalPath}`,
          source: 'Workday',
          postedAt: now,
          seenAt: now,
          applied: false,
        };
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

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, queue.length) },
    async () => {
      while (queue.length > 0) {
        const target = queue.shift();
        if (!target) return;
        await pollOnePw(target);
      }
    },
  );
  await Promise.all(workers);
  await browser.close();
  return { jobs, csrfConfirmedSlugs, csrfFailedSlugs };
}

// Persist Workday Playwright outcomes back to ats-targets.json so future
// cycles can short-circuit: successful tenants skip the doomed direct CXS
// call (wdCsrfRequired:true), and tenants that always fail Playwright skip
// the entire fallback path (wdSkipPlaywright:true). Re-reads the config at
// write time to avoid clobbering concurrent saveDiscoveredTargets writes.
function cacheWorkdayFlags(confirmed: string[], failed: string[]): void {
  if (confirmed.length === 0 && failed.length === 0) return;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const existing: ATSTarget[] = raw.targets || [];
    const confirmedSet = new Set(confirmed);
    const failedSet = new Set(failed);
    let confirmedCount = 0;
    let failedCount = 0;
    for (const t of existing) {
      if (t.ats !== 'workday') continue;
      if (confirmedSet.has(t.slug) && !t.wdCsrfRequired) {
        t.wdCsrfRequired = true;
        confirmedCount++;
      }
      if (failedSet.has(t.slug) && !t.wdSkipPlaywright) {
        t.wdSkipPlaywright = true;
        failedCount++;
      }
    }
    if (confirmedCount > 0 || failedCount > 0) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ targets: existing }, null, 2));
      const parts = [];
      if (confirmedCount > 0) parts.push(`${confirmedCount} wdCsrfRequired`);
      if (failedCount > 0) parts.push(`${failedCount} wdSkipPlaywright`);
      console.log(`[ats] Cached Workday flags for ${parts.join(', ')} tenant(s)`);
    }
  } catch (e: any) {
    console.warn(`[ats] Failed to cache Workday flags: ${e.message}`);
  }
}

export async function pollATS(): Promise<Partial<Internship>[]> {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.warn('[ats] No config at', CONFIG_PATH);
    return [];
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const targets: ATSTarget[] = config.targets || [];
  const now = new Date().toISOString();
  const results: Partial<Internship>[] = [];

  // Separate Playwright-required Workday targets to batch browser startup
  const csrfTargets = targets.filter(t => t.ats === 'workday' && t.wdCsrfRequired);
  const regularTargets = targets.filter(t => !(t.ats === 'workday' && t.wdCsrfRequired));
  // Workday targets that 422 in the direct CXS call get queued here for the
  // Playwright/CSRF fallback (and cached as wdCsrfRequired after first success).
  const csrfFallback: ATSTarget[] = [];

  // Worker pool — N targets processed in parallel. Network-bound work, so
  // ramping concurrency well above CPU count is fine. Per-host load stays
  // reasonable in practice because targets are spread across many ATS hosts.
  const CONCURRENCY = parseInt(process.env.ATS_POLL_CONCURRENCY || '8', 10);
  const queue = [...regularTargets];

  async function pollOne(target: ATSTarget): Promise<void> {
    try {
      let jobs: Partial<Internship>[] = [];
      if (target.ats === 'greenhouse') jobs = await pollGreenhouse(target, now);
      else if (target.ats === 'lever') jobs = await pollLever(target, now);
      else if (target.ats === 'ashby') jobs = await pollAshby(target, now);
      else if (target.ats === 'workday') jobs = await pollWorkday(target, now);
      else if (target.ats === 'icims') jobs = await pollICIMS(target, now);
      else if (target.ats === 'smartrecruiters') jobs = await pollSmartRecruiters(target, now);
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

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, queue.length) },
    async () => {
      while (queue.length > 0) {
        const target = queue.shift();
        if (!target) return;
        await pollOne(target);
      }
    },
  );
  await Promise.all(workers);

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
      cacheWorkdayFlags(csrfConfirmedSlugs, csrfFailedSlugs);
    } catch (e: any) {
      console.warn(`[ats] Workday/Playwright batch failed: ${e.message}`);
    }
  }

  console.log(`[ats] Total: ${results.length} internships from ${targets.length} targets`);
  return results;
}
