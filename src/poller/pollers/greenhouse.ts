/**
 * Greenhouse public board discovery poller.
 *
 * Finds startups on Greenhouse.io by probing known startup slugs (YC alumni,
 * known unicorns, popular YC companies) and fetching their public job boards
 * via the Greenhouse Boards API. No API key required — this is the same public
 * API that Greenhouse's own job board widget uses.
 *
 * Rate limit: 1 request / 600ms per target to be respectful.
 */

import axios, { AxiosError } from 'axios';
import { Internship } from '../../lib/types';

const REQUEST_TIMEOUT = 10_000;
const RATE_LIMIT_MS = 600;

// ── Seed slugs ──────────────────────────────────────────────────────────────
// Known Greenhouse-using startups. Expand this list to discover more.
// Slugs are case-sensitive (e.g. "robinhood" not "Robinhood").
const SEED_SLUGS = [
  // Top YC startups (frequent intern postings)
  'airbnb', 'stripe', 'coinbase', 'dropship', 'notion', 'figma',
  'vercel', 'linear', 'descript', 'milo', 'loom', 'cal',
  'loops', 'braintrust', 'calendly', 'make', 'asana',
  'pagerduty', 'razorpay', 'intercom', 'retool', 'person',
  'lattice', 'vanta', 'anchor', 'rippling',
  'runway', 'outsite', 'mongodb', 'databricks', 'snowflake',
  'planetscale', 'neon', 'supabase', 'turso', 'luma',
  'algolia', 'fastapi', 'june', 'posthog', 'logrocket',
  // More YC companies with public Greenhouse boards
  'appliedllm', 'cartesia', 'cerebras', 'character', 'charlie',
  'clay', 'clickhouse', 'cloudflare', 'confluent', 'continum',
  'crowdstrike', 'datadog', 'descript', 'discord', 'doordash',
  'easyretro', 'elastic', 'expa', 'figma', 'final',
  'fingerprintjs', 'fleet', 'gojuryu', 'gong', 'gorilla',
  'grammarly', 'hasura', 'heights', 'hex', 'hqg',
  'hubspot', 'hunter', 'impact', 'innity', 'instabase',
  'ironclad', 'jitsu', 'kaust', 'kustomer', 'launchdarkly',
  'littlebeacon', 'miro', 'mitrevski', 'mongodb', 'netlify',
  'notion', 'openai', 'outseta', 'pagerduty', 'paper',
  'partition', 'patly', 'phanton', 'pipeliner', 'pitch',
  'plaid', 'planet', 'prolion', 'proof', 'proton',
  'ramp', 'retool', 'runp', 'scale', 'scribe',
  'segment', 'sendbird', 'sentry', 'signal', 'simplify',
  'slite', 'smiles', 'snyk', 'softlead', 'soundcloud',
  'spline', 'statsig', 'storytelle', 'stripe', 'studyfox',
  'superface', 'supabase', 'support', 'switch', 'tailwind',
  'together', 'turso', 'twilio', 'typebot', 'ultra',
  'upbound', 'val Town', 'varispe', 'vector', 'vercel',
  'viam', 'webstudio', 'windsurf', 'xata', 'ycombinator',
  'zencart', 'zod', 'zodbot', 'zustand',
];

interface GreenhouseJob {
  id: number;
  title: string;
  location: { name: string } | null;
  absolute_url: string;
  updated_at: string;
  departments?: Array<{ name: string }>;
  /** HTML body returned when fetched with `?content=true`. */
  content?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function isInternTitle(title: string): boolean {
  return /\bintern(ship)?\b/i.test(title);
}

/**
 * Fetch intern postings for one Greenhouse board slug.
 * Returns [] on 404 (company not on Greenhouse) or network error.
 */
async function fetchBoard(
  slug: string,
  now: string,
): Promise<Partial<Internship>[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  try {
    const { data } = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; InternshipTracker/1.0)',
      },
    });

    const jobs: GreenhouseJob[] = data.jobs || [];
    if (!jobs.length) return [];

    return jobs
      .filter((j) => isInternTitle(j.title))
      .map((j) => ({
        title: j.title,
        company: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        location: j.location?.name ?? undefined,
        description: stripHtml(j.content || '').slice(0, 4000) || undefined,
        link: j.absolute_url || `https://boards.greenhouse.io/${slug}/jobs/${j.id}`,
        source: 'Greenhouse',
        atsSource: 'greenhouse' as const,
        atsTarget: slug,
        atsJobId: String(j.id),
        postedAt: j.updated_at || now,
        seenAt: now,
        applied: false,
      }));
  } catch (e: any) {
    const status = e?.response?.status;
    // 404 = company not on Greenhouse — expected for many probed slugs, stay quiet
    if (status === 404) return [];
    const msg = status ? `HTTP ${status}` : (e?.code || e?.message || 'unknown error');
    console.warn(`[greenhouse-discovery] ${slug}: ${msg}`);
    return [];
  }
}

/**
 * Poll all seed Greenhouse boards for intern postings.
 * Probes up to `maxConcurrency` boards in parallel, respecting rate limits.
 */
export async function pollGreenhouseDiscovery(
  maxConcurrency = 5,
): Promise<Partial<Internship>[]> {
  const results: Partial<Internship>[] = [];
  const seen = new Set<string>(); // dedupe by link

  // Process in batches to limit concurrency
  for (let i = 0; i < SEED_SLUGS.length; i += maxConcurrency) {
    const batch = SEED_SLUGS.slice(i, i + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map(slug => fetchBoard(slug, new Date().toISOString())),
    );

    for (const jobs of batchResults) {
      for (const job of jobs) {
        if (!seen.has(job.link || '')) {
          seen.add(job.link || '');
          results.push(job);
        }
      }
    }

    // Respectful rate limiting between batches
    if (i + maxConcurrency < SEED_SLUGS.length) {
      await sleep(RATE_LIMIT_MS * maxConcurrency);
    }
  }

  console.log(`[greenhouse-discovery] Found ${results.length} intern postings across ${SEED_SLUGS.length} boards`);
  return results;
}