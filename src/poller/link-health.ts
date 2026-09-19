import type { StoredInternship } from '../lib/types';
import { getInternships, archiveInternshipsByIds, markLinkChecked } from '../lib/store';
import { pool } from '../lib/concurrency';
import { POLLED_SOURCES } from './sources';
import { linkState } from './ats';

/**
 * Liveness of rows that only a feed vouches for. Rows from boards we poll
 * every cycle are handled by the seen_at rule in reevaluate.ts; feeds
 * (SimplifyJobs, LinkedIn) keep listing a job for weeks after it closes, so
 * those rows get a direct check every CHECK_TTL_DAYS.
 */

const CHECK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function needsCheck(i: StoredInternship, now = Date.now()): boolean {
  if (POLLED_SOURCES.has(i.source)) return false;
  return !i.lastCheckedAt || now - new Date(i.lastCheckedAt).getTime() > CHECK_TTL_MS;
}

export async function checkFeedLinks(): Promise<{ checked: number; archived: number; unknown: number }> {
  const due = (await getInternships()).filter(i => needsCheck(i));
  const gone: string[] = [];
  const checked: string[] = [];
  let unknown = 0;
  // LinkedIn throttles above roughly one request per second; other hosts tolerate more.
  const linkedin = due.filter(i => /linkedin\.com/.test(i.link));
  const others = due.filter(i => !/linkedin\.com/.test(i.link));
  const run = async (i: StoredInternship) => {
    const state = await linkState(i.link);
    if (state === 'unknown') { unknown++; return; }
    checked.push(i.id);
    if (state === 'gone') gone.push(i.id);
  };
  await Promise.all([
    pool(others, 8, run),
    (async () => { for (const i of linkedin) { await run(i); await new Promise(r => setTimeout(r, 1200)); } })(),
  ]);
  await markLinkChecked(checked, gone);
  const archived = await archiveInternshipsByIds(gone, 'link gone');
  console.log(`[link-health] checked ${checked.length}/${due.length} feed rows, archived ${archived}, unknown ${unknown}`);
  return { checked: checked.length, archived, unknown };
}
