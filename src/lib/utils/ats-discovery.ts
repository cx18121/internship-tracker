import * as fs from 'node:fs';
import * as path from 'node:path';
import axios from 'axios';
import type { ATSTarget } from '../types';

export type { ATSTarget } from '../types';
export { discoverATSTarget } from '../ats-registry';

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'ats-targets.json');

/** Loader for data/ats-targets.json. Empty array when missing or malformed. */
export function loadATSTargets(): ATSTarget[] {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return Array.isArray(config?.targets) ? config.targets : [];
  } catch {
    return [];
  }
}
const DENYLIST_PATH = path.join(DATA_DIR, 'ats-discovery-denylist.json');

interface DenylistEntry { slug: string; reason?: string }
interface Denylist { denied: DenylistEntry[] }

/**
 * Slugs that must never be auto-added by `saveDiscoveredTargets` and that
 * should be actively pruned from ats-targets.json if they're already there.
 * Tracks dead Workday tenants and other boards that keep getting re-discovered
 * from SimplifyJobs links after deliberate removal.
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

// URL → ATSTarget parsing lives in src/lib/ats-registry.ts (one table shared
// with portal-scanner's job-id extractor). discoverATSTarget is re-exported
// above from that module so the public API stays unchanged.

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

/**
 * Does a public board exist for this slug? Used by the discovery scripts to
 * confirm candidates before appending them.
 */
export async function verifyAtsSlug(slug: string, ats: 'greenhouse' | 'lever' | 'ashby', timeoutMs = 8000): Promise<boolean> {
  const opts = { timeout: timeoutMs, validateStatus: () => true };
  try {
    if (ats === 'greenhouse') {
      const res = await axios.get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, opts);
      return res.status === 200 && Array.isArray(res.data?.jobs);
    }
    if (ats === 'lever') {
      const res = await axios.get(`https://api.lever.co/v0/postings/${slug}?mode=json`, opts);
      return res.status === 200 && Array.isArray(res.data);
    }
    const res = await axios.get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, opts);
    return res.status === 200 && Array.isArray(res.data?.jobs);
  } catch {
    return false;
  }
}
