/**
 * Lever.co public board discovery poller.
 *
 * Finds startups on Lever.co by probing known startup slugs and fetching their
 * public job board via the Lever.co public API. No API key required.
 *
 * Lever boards are at https://boards.lever.co/<slug> or
 * https://<slug>.lever.co. This poller tries the boards-api endpoint first
 * (the public JSON API used by Lever's own embed widget).
 *
 * Rate limit: 1 request / 600ms per target to be respectful.
 */

import axios from 'axios';
import { Internship } from '../../lib/types.js';

const REQUEST_TIMEOUT = 10_000;
const RATE_LIMIT_MS = 600;

// Known Lever-using startups. Slugs are case-sensitive.
const SEED_SLUGS = [
  'airbnb', 'notion', 'figma', 'coinbase', 'vercel', 'linear',
  'descript', 'loom', 'cal', 'loops', 'braintrust', 'calendly',
  'make', 'asana', 'pagerduty', 'intercom', 'retool', 'person',
  'lattice', 'vanta', 'rippling', 'mongodb', 'databricks',
  'snowflake', 'planetscale', 'neon', 'supabase', 'algolia',
  'posthog', 'logrocket', 'stripe', 'discard', 'datadog',
  'confluent', 'crowdstrike', 'doordash', 'gong', 'grammarly',
  'hubspot', 'launchdarkly', 'miro', 'netlify', 'plaid',
  'segment', 'sentry', 'slite', 'snyk', 'twilio', 'vercel',
  'woven', '高度', 'brex', 'carvana', 'clubhouse', 'comm',
  'draft', 'fy', 'gs', 'happ', 'inst',
  'lily', 'mm', 'ngis', 'north', 'nuo', 'pipe',
  'plex', 'ramp', 'risk', 'rivian', 'rust', 'sim',
  'snow', 'tesla', 'tier', 'trogon', 'vale', 'vdoo',
  'wiz', 'zest', 'zoc', 'zu', 'ab', 'app',
  'bench', 'bloom', 'cabo', 'campo', 'canva', 'ches',
  'chrome', 'clear', 'click', 'clover', 'conf', 'crowdstrike',
  'darwin', 'deliv', 'delta', 'desk', 'dialpad', 'doist',
  'drip', 'drop', 'dune', 'dy', 'earnin', 'easypost',
  'envoy', 'etsy', 'eventbrite', 'fabulous', 'faith', 'fivetran',
  'flow', 'fly', 'front', 'fullstory', 'gitlab', 'gusto',
  'gyminho', 'harvest', 'he', 'hear', 'help', 'hightouch',
  'homebrew', 'hopper', 'hydra', 'ibm', 'imgur', 'insight',
  'iris', 'kaho', 'klaviyo', 'lever', 'lighthouse', 'loft',
  'lyft', 'malwarebo', 'melt', 'metro', 'mixpanel', 'morning',
  'moss', 'notion', 'ous', 'paper', 'param', 'pass',
  'pendo', 'perplexity', 'person', 'philo', 'pigeon', 'plex',
  'poBox', 'proud', 'quant', 'quiz', 'rally', 'recharge',
  'red', 'ref', 'renta', 'right', 'rivian', 'run',
  'salesforce', 'samsara', 'scout', 'sees', 'sense', 'sentry',
  'shopify', 'signal', 'simple', 'slack', 'smartcar', 'smile',
  'snap', 'splice', 'spotify', 'stair', 'status', 'story',
  'strip', 'stytch', 'sun', 'super', 'sv', 'sweep',
  'teachable', 'tesla', 'tinder', 'train', 'tree', 'triple',
  'trulio', 'turo', 'tutors', 'twilio', 'typeform', 'uber',
  'uptake', 'urgently', 'valo', 'van', 'venv', 'vercel',
  'viam', 'vine', 'vr', 'vu', 'walk', 'wealthfront',
  'whimsical', 'wish', 'workday', 'y', 'yousician', 'zapier',
  'ze', 'zen', 'zilla', 'zip', 'zopa',
];

interface LeverPosting {
  text: string;
  hostedUrl: string;
  applyUrl: string;
  categories: {
    commitment?: string;
    location?: string;
    department?: string;
    team?: string;
  };
  createdAt: number; // Unix ms
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isInternTitle(title: string): boolean {
  return /\bintern(ship)?\b/i.test(title);
}

function slugToName(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Fetch all postings for one Lever board via the public JSON API.
 * Returns [] on 404 (company not on Lever) or network error.
 */
async function fetchBoard(
  slug: string,
  now: string,
): Promise<Partial<Internship>[]> {
  // Try the public boards API (no API key needed)
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  try {
    const { data } = await axios.get<any[]>(url, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; InternshipTracker/1.0)',
      },
    });

    const postings: LeverPosting[] = Array.isArray(data) ? data : [];
    if (!postings.length) return [];

    return postings
      .filter((j) => {
        const titleMatch = isInternTitle(j.text || '');
        const commitmentMatch =
          (j.categories?.commitment || '').toLowerCase() === 'internship';
        return titleMatch || commitmentMatch;
      })
      .map((j) => ({
        title: j.text || '',
        company: slugToName(slug),
        location: j.categories?.location ?? j.categories?.commitment ?? undefined,
        link: j.hostedUrl || j.applyUrl || '',
        source: 'Lever',
        atsSource: 'lever' as const,
        atsTarget: slug,
        postedAt: j.createdAt
          ? new Date(j.createdAt).toISOString()
          : now,
        seenAt: now,
        applied: false,
      }));
  } catch {
    // 404 / 403 / network error → company not on Lever or blocked
    return [];
  }
}

/**
 * Poll all seed Lever boards for intern postings.
 * Probes up to `maxConcurrency` boards in parallel, respecting rate limits.
 */
export async function pollLeverDiscovery(
  maxConcurrency = 5,
): Promise<Partial<Internship>[]> {
  const results: Partial<Internship>[] = [];
  const seen = new Set<string>();

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

    if (i + maxConcurrency < SEED_SLUGS.length) {
      await sleep(RATE_LIMIT_MS * maxConcurrency);
    }
  }

  console.log(`[lever-discovery] Found ${results.length} intern postings across ${SEED_SLUGS.length} boards`);
  return results;
}