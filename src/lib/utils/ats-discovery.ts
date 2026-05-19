import * as fs from 'fs';
import * as path from 'path';

export interface ATSTarget {
  slug: string;
  ats: 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'icims' | 'smartrecruiters';
  name?: string;
  board?: string;      // Workday: job board name (e.g. 'NVIDIAExternalCareerSite')
  wdInstance?: string; // Workday: instance suffix (e.g. 'wd5')
  wdDomain?: string;   // Workday: base domain ('myworkdaysite.com' for site variant, default 'myworkdayjobs.com')
}

const CONFIG_PATH = path.join(process.cwd(), 'data', 'ats-targets.json');

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
 * Append newly discovered targets to data/ats-targets.json (de-duplicated by slug).
 * Returns the number of targets actually added.
 */
export function saveDiscoveredTargets(targets: ATSTarget[]): number {
  if (targets.length === 0) return 0;

  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const existing: ATSTarget[] = raw.targets || [];

  let added = 0;
  let enriched = 0;
  for (const target of targets) {
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

  if (added > 0 || enriched > 0) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ targets: existing }, null, 2));
  }
  return added;
}
