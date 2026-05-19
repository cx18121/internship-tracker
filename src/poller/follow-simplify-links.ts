// follow-simplify-links.ts
// Follows simplify.jobs redirect URLs to discover the final ATS URL,
// then extracts ATS targets and saves new ones to data/ats-targets.json.

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { discoverATSTarget, saveDiscoveredTargets, ATSTarget } from '../lib/utils/ats-discovery.js';

const INTERNSHIPS_PATH = path.join(process.cwd(), 'data', 'internships.json');
const CONCURRENCY = 5;
const TIMEOUT = 10_000;

async function resolveRedirect(url: string): Promise<string | null> {
  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      maxRedirects: 10,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: (s) => s < 500,
    });
    return res.request?.res?.responseUrl || (res.config as any)?.url || url;
  } catch (e: any) {
    // axios follows redirects — if it throws, we may still get a finalUrl from the error
    if (e.request?.res?.responseUrl) return e.request.res.responseUrl;
    return null;
  }
}

async function runPool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const myIdx = idx++;
      results[myIdx] = await tasks[myIdx]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const internships: any[] = JSON.parse(fs.readFileSync(INTERNSHIPS_PATH, 'utf-8'));
  const simplifyLinks = internships.filter(i => i.link?.includes('simplify.jobs'));
  console.log(`[follow-simplify] Found ${simplifyLinks.length} simplify.jobs entries`);

  const discovered: ATSTarget[] = [];
  let resolved = 0;
  let skipped = 0;

  const tasks = simplifyLinks.map(item => async () => {
    const finalUrl = await resolveRedirect(item.link);
    if (!finalUrl || finalUrl.includes('simplify.jobs')) {
      skipped++;
      return;
    }
    resolved++;
    const target = discoverATSTarget(finalUrl, item.company || '');
    if (target) {
      discovered.push(target);
      console.log(`[follow-simplify] ${item.company}: ${item.link} → ${finalUrl} (${target.ats})`);
    }
  });

  await runPool(tasks, CONCURRENCY);

  console.log(`\n[follow-simplify] Resolved: ${resolved}, Skipped/failed: ${skipped}`);
  const added = saveDiscoveredTargets(discovered);
  console.log(`[follow-simplify] New ATS targets added: ${added}`);
  console.log(`[follow-simplify] Total discovered (including enrichments): ${discovered.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
