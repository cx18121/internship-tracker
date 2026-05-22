import * as fs from 'fs';
import * as path from 'path';
import type { ATSTarget } from '../types';

export type { ATSTarget } from '../types';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'ats-targets.json');

/**
 * Shared loader for data/ats-targets.json. Single source of truth for the
 * read path — runtime sites (pollATS, portal-scanner, /api/sources) call
 * this instead of inline JSON.parse so a schema change touches one place.
 *
 * Returns an empty array if the file is missing or malformed; callers
 * should treat that as "no targets configured" rather than fatal.
 */
export function loadATSTargets(): ATSTarget[] {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return Array.isArray(config?.targets) ? config.targets : [];
  } catch {
    return [];
  }
}
const DENYLIST_PATH = path.join(process.cwd(), 'data', 'ats-discovery-denylist.json');

interface DenylistEntry { slug: string; reason?: string }
interface Denylist { denied: DenylistEntry[] }

/**
 * Slugs that must never be auto-added by `saveDiscoveredTargets` and that
 * should be actively pruned from ats-targets.json if they're already there.
 * Tracks dead Workday tenants and other boards that keep getting re-discovered
 * from SimplifyJobs / Handshake links after deliberate removal.
 *
 * Returns an empty set if the file is missing or malformed — the deny-list
 * is curation negation, optional by default.
 */
function loadDenylist(): Set<string> {
  try {
    if (!fs.existsSync(DENYLIST_PATH)) return new Set();
    const raw = JSON.parse(fs.readFileSync(DENYLIST_PATH, 'utf-8')) as Denylist;
    return new Set((raw.denied ?? []).map(e => e.slug));
  } catch {
    return new Set();
  }
}

const ATS_PATTERNS: Array<{
  test: (hostname: string, pathname: string) => boolean;
  extract: (hostname: string, pathname: string) => Omit<ATSTarget, 'name'> | null;
}> = [
  {
    // Greenhouse: boards.greenhouse.io/{slug}/... or job-boards.greenhouse.io/{slug}/...
    test: (h) => h === 'boards.greenhouse.io' || h === 'job-boards.greenhouse.io',
    extract: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'greenhouse' } : null;
    },
  },
  {
    // Lever: jobs.lever.co/{slug}/... or lever.co/{slug}/...
    test: (h) => h === 'jobs.lever.co' || h === 'lever.co',
    extract: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'lever' } : null;
    },
  },
  {
    // Ashby: jobs.ashbyhq.com/{slug}/...
    test: (h) => h === 'jobs.ashbyhq.com',
    extract: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'ashby' } : null;
    },
  },
  {
    // Workday: {company}.wd*.myworkdayjobs.com or {company}.myworkdayjobs.com
    // URL: https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/...
    // → slug = nvidia, wdInstance = wd5, board = NVIDIAExternalCareerSite
    test: (h) => h.endsWith('.myworkdayjobs.com'),
    extract: (h, p) => {
      const parts = h.split('.');
      const slug = parts[0];
      if (!slug) return null;
      // wdInstance: wd1/wd3/wd5 etc. (middle segment if present)
      const wdInstance = parts.length >= 4 ? parts[1] : undefined;
      // board: first path segment, skipping locale prefixes like 'en-US' or 'en_US'
      const pathParts = p.split('/').filter(Boolean);
      const board = pathParts.find(seg => !/^[a-z]{2}[-_][A-Z]{2}$/.test(seg)) || undefined;
      return { slug, ats: 'workday', ...(board ? { board } : {}), ...(wdInstance ? { wdInstance } : {}) };
    },
  },
  {
    // Workday (site variant): {wdInstance}.myworkdaysite.com/recruiting/{slug}/{board}/job/...
    // URL: https://wd3.myworkdaysite.com/recruiting/magna/Magna/job/...
    // → slug = magna, wdInstance = wd3, board = Magna, wdDomain = myworkdaysite.com
    test: (h) => h.endsWith('.myworkdaysite.com'),
    extract: (h, p) => {
      const wdInstance = h.split('.')[0]; // e.g. 'wd3'
      if (!wdInstance) return null;
      // Path: [locale?], 'recruiting', slug, board, 'job', ...
      const pathParts = p.split('/').filter(Boolean);
      const localePattern = /^[a-z]{2}[-_][A-Z]{2}$/;
      const filtered = pathParts.filter(seg => !localePattern.test(seg));
      const recIdx = filtered.indexOf('recruiting');
      if (recIdx < 0 || filtered.length < recIdx + 2) return null;
      const slug = filtered[recIdx + 1];
      const board = filtered[recIdx + 2];
      return {
        slug,
        ats: 'workday',
        board,
        wdInstance,
        wdDomain: 'myworkdaysite.com',
      };
    },
  },
  {
    // SmartRecruiters: jobs.smartrecruiters.com/{companySlug}/{jobId}
    test: (h) => h === 'jobs.smartrecruiters.com',
    extract: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'smartrecruiters' } : null;
    },
  },
  {
    // iCIMS: careers-{slug}.icims.com or {slug}.icims.com
    test: (h) => h.endsWith('.icims.com'),
    extract: (h) => {
      const sub = h.replace('.icims.com', '');
      const slug = sub.startsWith('careers-') ? sub.slice('careers-'.length) : sub;
      return slug ? { slug, ats: 'icims' } : null;
    },
  },
];

/**
 * Parse a direct ATS link to detect known ATS platforms.
 * Returns an ATSTarget if the link matches a known platform, null otherwise.
 */
export function discoverATSTarget(link: string, companyName: string): ATSTarget | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname;

  for (const pattern of ATS_PATTERNS) {
    if (pattern.test(hostname, pathname)) {
      const result = pattern.extract(hostname, pathname);
      if (result) {
        return { ...result, name: companyName };
      }
    }
  }
  return null;
}

/**
 * Append newly discovered targets to data/ats-targets.json (de-duplicated by slug),
 * filtered through the deny-list. Returns the number of targets actually added.
 *
 * Deny-list semantics: any slug present in data/ats-discovery-denylist.json
 * is both (a) rejected from incoming `targets` and (b) actively pruned from
 * the existing on-disk list. The second part matters because the Railway
 * persistent volume hangs onto stale entries that were removed from git;
 * adding to the deny-list is how we make those removals stick.
 */
export function saveDiscoveredTargets(targets: ATSTarget[]): number {
  if (targets.length === 0) return 0;

  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  let existing: ATSTarget[] = raw.targets || [];
  const denied = loadDenylist();

  // Prune any existing target whose slug is on the deny-list. Counts toward
  // a "pruned" log line so deploy-time cleanup is visible.
  let pruned = 0;
  if (denied.size > 0) {
    const before = existing.length;
    existing = existing.filter(t => !denied.has(t.slug));
    pruned = before - existing.length;
    if (pruned > 0) {
      console.log(`[ats-discovery] Pruned ${pruned} deny-listed target(s) from ats-targets.json`);
    }
  }

  let added = 0;
  let enriched = 0;
  let rejected = 0;
  for (const target of targets) {
    if (denied.has(target.slug)) {
      rejected++;
      continue;
    }
    const existingIdx = existing.findIndex((t: ATSTarget) => t.slug === target.slug);
    if (existingIdx < 0) {
      existing.push(target);
      added++;
      console.log(`[ats-discovery] New target: ${target.name} (${target.slug}) → ${target.ats}`);
    } else {
      // Enrich existing Workday targets that are missing board/wdInstance
      const ex = existing[existingIdx];
      if (target.ats === 'workday' && target.board && !ex.board) {
        existing[existingIdx] = {
          ...ex,
          board: target.board,
          ...(target.wdInstance ? { wdInstance: target.wdInstance } : {}),
        };
        enriched++;
        console.log(`[ats-discovery] Enriched Workday target: ${ex.name || ex.slug} → board=${target.board}`);
      }
    }
  }

  if (rejected > 0) {
    console.log(`[ats-discovery] Rejected ${rejected} deny-listed discovery candidate(s)`);
  }

  if (added > 0 || enriched > 0 || pruned > 0) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ targets: existing }, null, 2));
  }
  return added;
}
