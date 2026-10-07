import axios from 'axios';
import type { Ats, PostingDetails } from './types';
import { TIMEOUT_MS, MAX_DESC_LEN, JSON_HEADERS, HTML_HEADERS, probe, boardAnswers } from './http';
import { openingFacts, explicitInternshipTerms } from '../../lib/opportunity';
import { isInternTitle } from '../utils/intern-signal';
import { stripHtml, identityText, decodeHtmlEntities } from '../utils/html';
import { buildPosting } from '../utils/build-row';

interface GreenhouseJob {
  id: number;
  internal_job_id?: number | null;
  requisition_id?: string | null;
  company_name?: string;
  title?: string;
  absolute_url?: string;
  updated_at?: string;
  content?: string;
  location?: { name?: string };
}

const boardApi = (slug: string) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
const jobApi = (slug: string, id: string) => `${boardApi(slug)}/${id}?content=true`;

/** Extract opening evidence before capping the description sent to classification. */
export function greenhouseDetails(slug: string, job: GreenhouseJob): PostingDetails {
  const full = identityText(job.content ?? '');
  const title = stripHtml(job.title ?? '');
  const sourceUrl = job.absolute_url || `https://job-boards.greenhouse.io/${slug}/jobs/${job.id}`;
  const tenant = slug.toLowerCase();
  return { description: full.slice(0, MAX_DESC_LEN), identity: {
    postingKey: `greenhouse:${tenant}:post:${job.id}`,
    sourceUrl, title, terms: explicitInternshipTerms(title, full),
    ...(job.internal_job_id != null ? { openingKey: `greenhouse:${tenant}:internal:${job.internal_job_id}` } : {}),
    ...(job.requisition_id ? { requisitionKey: `greenhouse:${tenant}:req:${job.requisition_id}` } : {}),
    ...(job.company_name ? { employer: { name: job.company_name, reference: jobApi(slug, String(job.id)), kind: 'greenhouse' as const } } : {}),
    facts: openingFacts(full),
  } };
}

/** The official embed's canonical URL can supply a missing tenant. Never infer it from a job ID or company name. */
export function greenhouseEmbedTenant(html: string, id: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel=["']canonical["']/i.test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    try {
      const url = new URL(decodeHtmlEntities(href ?? ''));
      const tenant = url.searchParams.get('for');
      if (/^https?:$/.test(url.protocol) && /^(?:boards|job-boards)\.greenhouse\.io$/.test(url.hostname) &&
          url.pathname === '/embed/job_app' && url.searchParams.get('token') === id && tenant && /^[a-z0-9_-]+$/i.test(tenant)) return tenant.toLowerCase();
    } catch { /* No source-provided tenant. */ }
  }
  return undefined;
}

// The board response, unlike the configured display name, is employer evidence.
const boardNames = new Map<string, Promise<string | undefined>>();
async function boardName(slug: string): Promise<string | undefined> {
  if (!boardNames.has(slug)) boardNames.set(slug, (async () => {
    try {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`, { headers: JSON_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) return undefined;
      const data = await r.json() as { name?: string };
      return data.name || undefined;
    } catch { return undefined; }
  })());
  const name = await boardNames.get(slug)!;
  if (!name) boardNames.delete(slug); // A failed lookup must be retryable next cycle.
  return name;
}

/**
 * Links: boards.greenhouse.io/{slug}/jobs/{id}, job-boards.greenhouse.io/{slug}/jobs/{id},
 * boards.greenhouse.io/embed/job_app?token={id}, and company career pages with ?gh_jid={id}
 * (no slug, so only the id is known).
 */
export const greenhouse: Ats = {
  kind: 'greenhouse',
  source: 'Greenhouse',
  matchUrl: (h, p) => h.endsWith('greenhouse.io') || /[?&]gh_jid=\d+/.test(p),
  targetFromUrl: (h, p) => {
    if (!h.endsWith('greenhouse.io')) return null;
    const slug = p.split('/').filter(Boolean)[0];
    return slug && slug !== 'embed' ? { slug, ats: 'greenhouse' } : null;
  },
  jobFromUrl: (url) => {
    const m = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    if (m && m[1] !== 'embed') return { slug: m[1], jobId: m[2] };
    const id = url.searchParams.get('gh_jid') ?? (url.pathname.includes('/embed/job_app') ? url.searchParams.get('token') : null);
    const tenant = url.pathname.includes('/embed/job_app') ? url.searchParams.get('for') : null;
    return id && /^\d+$/.test(id) ? { slug: tenant && /^[a-z0-9_-]+$/i.test(tenant) ? tenant : '', jobId: id } : null;
  },
  boardExists: (slug, timeoutMs) => boardAnswers(boardApi(slug), d => Array.isArray((d as { jobs?: unknown })?.jobs), timeoutMs),
  alive: (job) => (job.slug ? probe(jobApi(job.slug, job.jobId)) : Promise.resolve('unknown')),
  details: async (job, link) => {
    try {
      let tenant = job.slug;
      if (!tenant) {
        const url = new URL(link);
        if (!/^(?:boards|job-boards)\.greenhouse\.io$/.test(url.hostname) || url.pathname !== '/embed/job_app') return { description: '' };
        const page = await fetch(url, { headers: HTML_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!page.ok || !/^(?:boards|job-boards)\.greenhouse\.io$/.test(new URL(page.url || link).hostname)) return { description: '' };
        tenant = greenhouseEmbedTenant(await page.text(), job.jobId) ?? '';
        if (!tenant) return { description: '' };
      }
      const r = await fetch(jobApi(tenant, job.jobId), { headers: JSON_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return r.ok ? greenhouseDetails(tenant, await r.json() as GreenhouseJob) : { description: '' };
    } catch { return { description: '' }; }
  },
  poll: async (target, now) => {
    const { data } = await axios.get<{ jobs?: GreenhouseJob[] }>(`${boardApi(target.slug)}?content=true`, { timeout: TIMEOUT_MS });
    const company = target.name || target.slug;
    const jobs = (data.jobs ?? []).filter(j => isInternTitle(j.title ?? ''));
    const name = jobs.length ? await boardName(target.slug) : undefined;
    return jobs.map(j => buildPosting({
        title: stripHtml(j.title ?? ''),
        company,
        locations: (j.location?.name ?? '').split(';'),
        link: j.absolute_url || `https://boards.greenhouse.io/${target.slug}/jobs/${j.id}`,
        source: 'Greenhouse',
        upstreamPostedAt: j.updated_at,
        now,
        descriptionHtml: j.content,
        identity: greenhouseDetails(target.slug, { ...j, company_name: j.company_name ?? name }).identity,
      }));
  },
};
