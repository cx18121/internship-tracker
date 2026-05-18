/**
 * find-ats-links-daily.ts
 *
 * Daily cron job: finds direct ATS/careers links for high-quality internship
 * listings that are currently stuck behind aggregator links (Handshake/Indeed/LinkedIn).
 *
 * Process:
 * 1. Query internships with grade A or B from aggregator sources
 * 2. For each, run targeted Brave searches for direct ATS board URLs
 * 3. Where found, update the internship entry with the direct link
 * 4. Log results to scripts/logs/find-ats-links-YYYY-MM-DD.log
 *
 * Run: node --loader ts-node/esm src/scripts/find-ats-links-daily.ts
 * Cron:  30 10 * * *  (10:30am ET daily, after daily brief)
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const IT_API_BASE = 'http://localhost:3001';
const LOG_DIR = path.join(process.cwd(), 'scripts', 'logs');
const LOG_FILE = path.join(LOG_DIR, `find-ats-links-${formatDate(new Date())}.log`);

// ── Config ────────────────────────────────────────────────────────────────────

const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
const BRAVE_BASE = 'https://api.search.brave.com/res/v1/web/search';
const SEARCH_DELAY_MS = 2000;
const MAX_PER_RUN = 20;

// ── Types ────────────────────────────────────────────────────────────────────

interface Internship {
  id: string;
  title: string;
  company: string;
  location: string | null;
  link: string;
  source: string;
  postedAt: string;
  seenAt: string;
  score: number;
  grade: string;
  applied: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function braveSearch(query: string, count = 10): Promise<any[]> {
  if (!BRAVE_API_KEY) {
    log('BRAVE_API_KEY not set — skipping');
    return [];
  }
  try {
    const { data } = await axios.get(BRAVE_BASE, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
      params: { q: query, count },
      timeout: 15_000,
    });
    return data?.web?.results?.items || [];
  } catch (e) {
    log(`Brave API error: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch internships from the tracker API */
async function fetchTargetInternships(): Promise<Internship[]> {
  const res = await axios.get<{ data: Internship[]; count: number }>(
    `${IT_API_BASE}/api/internships`,
    {
      params: {
        label: 'A,B',               // grade A or B
        minScore: 60,              // score >= 60
        source: 'Handshake',       // aggregator sources only
        limit: 500,
        sort: 'score',
      },
      timeout: 10_000,
    },
  );

  // The API doesn't support multiple sources in one call — also fetch Indeed and Linkedin
  const [handshake, indeed, linkedin] = await Promise.all([
    axios.get<{ data: Internship[]; count: number }>(`${IT_API_BASE}/api/internships`, {
      params: { label: 'A,B', minScore: 60, source: 'Handshake', limit: 500, sort: 'score' },
      timeout: 10_000,
    }),
    axios.get<{ data: Internship[]; count: number }>(`${IT_API_BASE}/api/internships`, {
      params: { label: 'A,B', minScore: 60, source: 'Indeed', limit: 500, sort: 'score' },
      timeout: 10_000,
    }),
    axios.get<{ data: Internship[]; count: number }>(`${IT_API_BASE}/api/internships`, {
      params: { label: 'A,B', minScore: 60, source: 'Linkedin', limit: 500, sort: 'score' },
      timeout: 10_000,
    }),
  ]);

  type InternSource = { data: Internship[] };
  const combined: Internship[] = [
    ...(handshake.data as InternSource).data,
    ...(indeed.data as InternSource).data,
    ...(linkedin.data as InternSource).data,
  ];

  // Dedupe by id
  const seen = new Set<string>();
  const unique = combined.filter((i) => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });

  log(`Fetched ${unique.length} target listings (A/B grade, aggregator sources)`);
  return unique.slice(0, MAX_PER_RUN);
}

/** Run search queries to find direct ATS URL for a listing */
async function findDirectLink(
  internship: Internship,
): Promise<{ directUrl: string; platform: string } | null> {
  const { title, company } = internship;

  // Normalize title for search: strip year prefixes like "2026", "2025"
  const cleanTitle = title.replace(/^(202[5-9]|203[0-9])\s*[-\s]*/i, '');

  const queries = [
    // Primary: site-specific with title keyword
    `${company} ${cleanTitle} site:boards.greenhouse.io`,
    `${company} ${cleanTitle} site:jobs.lever.co`,
    `${company} ${cleanTitle} site:jobs.ashbyhq.com`,
    // Fallback: broader careers page search
    `${company} careers ${cleanTitle} internship`,
    `${company} internship ${cleanTitle}`,
  ];

  for (const query of queries) {
    const results = await braveSearch(query, 5);
    for (const r of results) {
      const url: string = r.url || '';
      let platform: 'greenhouse' | 'lever' | 'ashby' | null = null;
      let slug = '';

      if (url.includes('boards.greenhouse.io')) {
        platform = 'greenhouse';
        const m = url.match(/boards\.greenhouse\.io\/([^\/]+)/);
        slug = m ? m[1] : '';
      } else if (url.includes('jobs.lever.co')) {
        platform = 'lever';
        const m = url.match(/jobs\.lever\.co\/([^\/]+)/);
        slug = m ? m[1] : '';
      } else if (url.includes('jobs.ashbyhq.com')) {
        platform = 'ashby';
        const m = url.match(/jobs\.ashbyhq\.com\/([^\/]+)/);
        slug = m ? m[1] : '';
      }

      if (platform && slug) {
        const directUrl =
          platform === 'greenhouse'
            ? `https://boards.greenhouse.io/${slug}`
            : platform === 'lever'
              ? `https://jobs.lever.co/${slug}`
              : `https://jobs.ashbyhq.com/${slug}`;

        return { directUrl, platform };
      }
    }
    await delay(SEARCH_DELAY_MS);
  }

  return null;
}

/** Verify a direct link actually works (probes the ATS board) */
async function verifyLink(
  directUrl: string,
  platform: string,
): Promise<boolean> {
  try {
    if (platform === 'greenhouse') {
      const slug = directUrl.split('/').pop() || '';
      const res = await axios.get(
        `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
        { timeout: 5000, headers: { Accept: 'application/json' } },
      );
      return Array.isArray(res.data?.jobs);
    }
    if (platform === 'lever') {
      const slug = directUrl.split('/').pop() || '';
      const res = await axios.get(
        `https://api.lever.co/v0/postings/${slug}?mode=json`,
        { timeout: 5000, headers: { Accept: 'application/json' } },
      );
      return Array.isArray(res.data);
    }
    if (platform === 'ashby') {
      const slug = directUrl.split('/').pop() || '';
      const res = await axios.get(
        `https://jobs.ashbyhq.com/api/${slug}/postings`,
        { timeout: 5000, headers: { Accept: 'application/json' } },
      );
      return Array.isArray(res.data?.jobs) || Array.isArray(res.data?.jobPostings);
    }
  } catch {
    // verification failed = link is dead/expired
  }
  return false;
}

/** Patch a single internship with a direct link + archive the old one */
async function patchInternship(
  id: string,
  directUrl: string,
  originalLink: string,
): Promise<boolean> {
  try {
    await axios.patch(`${IT_API_BASE}/api/internships/${id}`, {
      link: directUrl,
      applicationUrl: directUrl,
      archivedLink: originalLink,
    });
    return true;
  } catch (e) {
    log(
      `Failed to patch internship ${id}: ${e instanceof Error ? e.message : e}`,
    );
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  log('=== find-ats-links-daily started ===');

  const internships = await fetchTargetInternships();
  if (internships.length === 0) {
    log('No target listings found. Exiting.');
    return;
  }

  let found = 0;
  let updated = 0;
  let failed = 0;
  let skipped = 0;

  for (const internship of internships) {
    log(
      `Processing: ${internship.company} — ${internship.title.slice(0, 50)}`,
    );

    const result = await findDirectLink(internship);
    if (!result) {
      log(`  No direct ATS link found for ${internship.company}`);
      skipped++;
      continue;
    }

    log(`  Found candidate: ${result.directUrl} (${result.platform})`);

    const live = await verifyLink(result.directUrl, result.platform);
    if (!live) {
      log(`  Verification failed — link may be expired: ${result.directUrl}`);
      skipped++;
      continue;
    }

    const ok = await patchInternship(
      internship.id,
      result.directUrl,
      internship.link,
    );
    if (ok) {
      log(`  Updated: ${internship.id} → ${result.directUrl}`);
      updated++;
      found++;
    } else {
      failed++;
    }

    await delay(SEARCH_DELAY_MS);
  }

  log(
    `=== find-ats-links-daily done — found=${found} updated=${updated} skipped=${skipped} failed=${failed} ===`,
  );
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
