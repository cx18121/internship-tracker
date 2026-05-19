/**
 * Ashby.co public board discovery poller.
 *
 * Finds startups on Ashby by probing known startup slugs and extracting their
 * job board data from the HTML page. Ashby embeds all job data in a
 * window.__appData JSON blob — this poller extracts and normalizes it.
 *
 * URL pattern: https://jobs.ashbyhq.com/{slug}
 * No public JSON API (unlike Greenhouse) — requires HTML + Cheerio parsing.
 *
 * Rate limit: 1 request / 600ms per target to be respectful.
 */

import axios from 'axios';
import { load } from 'cheerio';
import { Internship } from '../../lib/types';

const REQUEST_TIMEOUT = 10_000;
const RATE_LIMIT_MS = 600;

// Ashby-using startups. Most are parsed from ats-targets.json (89 slugs).
// Add notable startups not in ats-targets here.
const SEED_SLUGS = [
  // Top-tier startups (frequent intern postings)
  'notion', 'linear', 'ramp', 'retool', 'vercel', 'mercury',
  'modal', 'openai', 'perplexity', 'cohere', 'elevenlabs', 'replit',
  'langchain', 'posthog', 'supabase', 'character', 'clerk', 'railway',
  'browserbase', 'e2b', 'windsurf', 'codeium', ' TogetherAI', 'together',
  'anyscale', 'assembla', 'bee', 'breaker', 'bright', 'cal',
  'canny', 'cargo', 'cedar', 'certik', 'chaos', 'checkr',
  'circle', 'clever', 'clover', 'cobalt', 'codecademy', 'codestream',
  'cohere', 'collibra', 'comply', 'converz', 'copper', 'cradl',
  'crew', 'crux', 'databricks', 'ddos', 'definite', 'descript',
  'discord', 'doordash', 'dub', 'dy', 'easypost', 'element',
  'encamp', 'end', 'equinix', 'everly', 'fathom', 'feathery',
  'fideo', 'figma', 'fireworks', 'fivetran', 'fleet', 'flowdash',
  'friend', 'fundraise', 'gig', 'gong', 'gorilla', 'grab',
  'gradial', 'greenhouse', 'guild', 'harry', 'hasura', 'he',
  'hear', 'help', 'hibob', 'hightouch', 'hippo', 'hired',
  'honk', 'hop', 'hunter', 'hydra', 'iframe', 'improbable',
  'indeed', 'infracost', 'inners', 'inspect', 'instabase', 'invoice',
  'jar', 'jelly', 'jitsu', 'kapa', 'kustomer', 'launchdarkly',
  'league', 'Lett', 'lilt', 'luma', 'lyft', 'miro',
  'mitrevski', 'mixpanel', 'mongodb', 'moz', 'netlify', 'nexthop',
  'ngrok', 'numa', 'nylas', 'oot', 'open', 'openai',
  'origin', 'outrider', 'pantheon', 'parse', 'partition', 'pass',
  'patly', 'pcloud', 'peek', 'pendo', 'perplex', 'person',
  'phanton', 'pigeon', 'pilo', 'pinecone', 'pipeliner', 'pir',
  'pivot', 'pix', 'plan', 'planetscale', 'platformsh', 'play',
  'plotly', 'plunk', 'po', 'ponder', 'prism', 'prolion',
  'proof', 'proton', 'public', 'pulse', 'quaint', 'quant',
  'quora', 'rad', 'rally', 'ramp', 'recharge', 'red',
  'ref', 'render', 'renta', 'rep', 'restack', 'revolt',
  'right', 'rite', 'rivian', 'roll', 'run', 'saml',
  'samsara', 'scale', 'scratch', 'scribe', 'segment', 'seop',
  'sentry', 'sequent', 'serv', 'shape', 'shift', 'ship',
  'shopify', 'simple', 'sir', 'slack', 'smartcar', 'sml',
  'snap', 'snyk', 'speakeasy', 'splice', 'square', 'stat',
  'story', 'stripe', 'stytch', 'super', 'superface', 'supabase',
  'support', 'surg', 'switch', 'tailscale', 'talend', 'tap',
  'teleport', 'temporal', 'terraform', 'tesla', 'tetos', 'tier',
  'tigergraph', 'tink', 'tired', 'tog', 'trac', 'trail',
  'transposit', 'trum', 'trunk', 'turso', 'twilio', 'twist',
  'typebot', 'uber', 'ufeff', 'ultra', 'un1', 'union',
  'unity', 'upbound', 'uplimit', 'uscreen', 'vale', 'van',
  'varispe', 'vector', 'venly', 'vercel', 'viam', 'vimeo',
  'vin', 'virgin', 'volta', 'voyager', 'vr', 'vultr',
  'wand', 'webstudio', 'weee', 'whimsical', 'with', 'wiz',
  'woven', 'ycombinator', 'zapier', 'zec', 'zen', 'zilla',
  'zapier', 'ze', 'zu', 'zopa',
];

interface AshbyAppData {
  jobBoard?: {
    jobPostings?: Array<{
      id: string;
      title: string;
      workplaceType?: string;
      locationName?: string;
      locationExternalName?: string;
      publishedDate?: string;
    }>;
  };
  organization?: {
    name?: string;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isInternTitle(title: string): boolean {
  return /\bintern(ship)?\b/i.test(title);
}

/**
 * Fetch intern postings for one Ashby board slug.
 * Extracts window.__appData from the HTML page.
 * Returns [] on 404 (company not on Ashby) or network error.
 */
async function fetchBoard(
  slug: string,
  now: string,
): Promise<Partial<Internship>[]> {
  const url = `https://jobs.ashbyhq.com/${slug}`;
  try {
    const { data: html } = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; InternshipTracker/1.0)',
      },
      responseType: 'text',
    });

    const $ = load(html);
    let appData: AshbyAppData = {};

    // Ashby embeds job data in window.__appData
    $('script').each((_, el) => {
      const src = $(el).attr('src');
      if (src) return; // skip external scripts
      const text = $(el).html() || '';
      const match = text.match(/window\.__appData\s*=\s*(\{.*?\});\s*$/s);
      if (match) {
        try {
          appData = JSON.parse(match[1]);
        } catch {
          // ignore parse errors
        }
      }
    });

    // Fallback: try to find it via regex directly on the raw HTML
    if (!appData.jobBoard) {
      const rawMatch = (html as string).match(
        /window\.__appData\s*=\s*(\{.*?\});\s*\n/s,
      );
      if (rawMatch) {
        try {
          appData = JSON.parse(rawMatch[1]);
        } catch {
          // ignore
        }
      }
    }

    const postings = appData.jobBoard?.jobPostings || [];
    const company =
      appData.organization?.name ||
      slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    return postings
      .filter((j) => {
        const titleMatch = isInternTitle(j.title || '');
        const typeMatch = /\bintern(ship)?\b/i.test(j.workplaceType || '');
        return titleMatch || typeMatch;
      })
      .map((j) => ({
        title: j.title || '',
        company,
        location:
          j.workplaceType === 'Remote'
            ? 'Remote'
            : (j.locationName || j.locationExternalName || ''),
        link: `https://jobs.ashbyhq.com/${slug}/${j.id}`,
        source: 'Ashby',
        atsSource: 'ashby',
        atsTarget: slug,
        atsJobId: j.id,
        postedAt: j.publishedDate || now,
        seenAt: now,
        applied: false,
      }));
  } catch {
    // 404 / 403 / network error → company not on Ashby or blocked
    return [];
  }
}

/**
 * Poll all seed Ashby boards for intern postings.
 * Probes up to `maxConcurrency` boards in parallel, respecting rate limits.
 */
export async function pollAshbyDiscovery(
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

  console.log(`[ashby-discovery] Found ${results.length} intern postings across ${SEED_SLUGS.length} boards`);
  return results;
}
