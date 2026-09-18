import axios from 'axios';
import type { RawPosting } from '../../lib/types';
import { parseSalary } from '../../lib/salary';
import { pool } from '../../lib/concurrency';
import { buildPosting } from '../utils/build-row';
import { decodeHtmlEntities } from '../utils/html';

// YC Work at a Startup server-renders each page's data as JSON in a
// <div data-page="..."> attribute, so plain HTTP is enough.
const BASE_URL = 'https://www.workatastartup.com';
const REQUEST_TIMEOUT = 20_000;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

// The unfiltered /jobs page exposes ~30 jobs and yields 0 to 3 interns. Each
// per-role page returns its own slice, so the union surfaces about 5x more.
const ROLE_PATHS = [
  '/jobs/l/software-engineer',
  '/jobs/l/designer',
  '/jobs/l/science',
  '/jobs/l/product-manager',
  '/jobs/l/operations',
  '/jobs/l/sales-manager',
  '/jobs/l/marketing',
  '/jobs/l/legal',
  '/jobs/l/finance',
  '/jobs/l/recruiting',
];

interface RawJob {
  id: number;
  title: string;
  /** 'Internship' | 'Full-time' | 'Contract' (upstream has renamed these before). */
  jobType: string;
  location: string;
  companyName: string;
  companyOneLiner: string;
  /** e.g. "$200K - $250K" */
  salary?: string;
}

async function fetchPageData(path: string): Promise<unknown | null> {
  const { data: html } = await axios.get<string>(`${BASE_URL}${path}`, {
    timeout: REQUEST_TIMEOUT,
    headers: HEADERS,
    responseType: 'text',
  });
  const match = /data-page="([\s\S]*?)"/.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(decodeHtmlEntities(match[1]));
  } catch {
    return null;
  }
}

async function fetchDescription(jobId: number): Promise<string | undefined> {
  const data = (await fetchPageData(`/jobs/${jobId}`)) as { props?: { job?: { descriptionHtml?: string } } } | null;
  return data?.props?.job?.descriptionHtml || undefined;
}

export async function pollYCWaaS(): Promise<RawPosting[]> {
  const now = new Date().toISOString();
  const interns = new Map<number, RawJob>();

  for (const path of ROLE_PATHS) {
    try {
      const data = (await fetchPageData(path)) as { props?: { jobs?: RawJob[] } } | null;
      if (!data) {
        console.warn(`[yc-waas] ${path}: no data-page attribute; markup may have changed`);
        continue;
      }
      for (const j of data.props?.jobs ?? []) {
        if (/intern/i.test(j.jobType || '')) interns.set(j.id, j);
      }
    } catch (e) {
      console.warn(`[yc-waas] ${path} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const jobs = [...interns.values()];
  const descriptions = new Map<number, string | undefined>();
  await pool(jobs, 4, async (j) => {
    descriptions.set(j.id, await fetchDescription(j.id).catch(() => undefined));
  });

  const results = jobs.map((j) => buildPosting({
    title: j.title,
    company: j.companyName,
    location: j.location,
    link: `${BASE_URL}/jobs/${j.id}`,
    source: 'YC WaaS',
    now,
    descriptionHtml: descriptions.get(j.id) ?? j.companyOneLiner,
    salary: j.salary ? parseSalary(j.salary) : undefined,
  }));

  console.log(`[yc-waas] Total: ${results.length} internships`);
  return results;
}
