import axios from 'axios';
import type { RawPosting, ATSTarget } from '../../lib/types';
import { loadATSTargets } from '../../lib/utils/ats-discovery';
import { ATS } from '../ats';
import { pool } from '../../lib/concurrency';
import { listedCompanyTier } from '../../lib/scorer';
import { getPromotedCompanyKeys } from '../../lib/store';
import { companyKey } from '../../lib/company-key';
import { canonicalizeCompany } from '../../lib/canonicalize-company';
import { stripEmojiPrefix } from '../../lib/utils/normalize';
import {
  pollWorkdayDirect, pollWorkdayViaPlaywright, overlayWorkdayFlags, saveWorkdayFlags,
  WorkdayHttpError, type InternFacets,
} from '../ats/workday';

// Startups hire through Ashby, Greenhouse, and Lever; the enterprise ATSes
// are dominated by employers nobody curated. Poll those only for companies
// in the scoring tiers or judged elite/top/hot by the classifier.
const CURATED_ONLY_ATS = new Set<ATSTarget['ats']>(['workday', 'icims', 'smartrecruiters']);

export function shouldPoll(target: ATSTarget, promoted: Set<string> = new Set()): boolean {
  if (!CURATED_ONLY_ATS.has(target.ats)) return true;
  const name = target.name || target.slug;
  return listedCompanyTier(name) !== null || promoted.has(companyKey(canonicalizeCompany(stripEmojiPrefix(name))));
}

export async function pollATS(): Promise<RawPosting[]> {
  const all = overlayWorkdayFlags(loadATSTargets());
  const promoted = await getPromotedCompanyKeys().catch(() => new Set<string>());
  const targets = all.filter(t => shouldPoll(t, promoted));
  if (targets.length === 0) {
    console.warn('[ats] No targets in data/ats-targets.json');
    return [];
  }
  if (targets.length < all.length) console.log(`[ats] Skipping ${all.length - targets.length} uncurated Workday/iCIMS/SmartRecruiters tenants`);
  const now = new Date().toISOString();
  const results: RawPosting[] = [];
  const discoveredFacets = new Map<string, InternFacets>();
  // Workday tenants that need the CSRF path: flagged from earlier cycles, plus
  // any that 422 this cycle. Tenants where Playwright has already failed are
  // skipped entirely rather than retried every hour.
  const csrfQueue = targets.filter(t => t.ats === 'workday' && t.wdCsrfRequired && !t.wdSkipPlaywright);
  const direct = targets.filter(t => !(t.ats === 'workday' && (t.wdCsrfRequired || t.wdSkipPlaywright)));

  const CONCURRENCY = parseInt(process.env.ATS_POLL_CONCURRENCY || '8', 10);
  await pool(direct, CONCURRENCY, async (target) => {
    const label = `${target.name || target.slug} (${target.ats})`;
    try {
      let jobs: RawPosting[];
      if (target.ats === 'workday') {
        const r = await pollWorkdayDirect(target, now);
        if (r.discoveredFacets) discoveredFacets.set(target.slug, r.discoveredFacets);
        jobs = r.postings;
      } else {
        jobs = await ATS[target.ats].poll!(target, now);
      }
      if (jobs.length > 0) {
        console.log(`[ats] ${label}: ${jobs.length} internships`);
        results.push(...jobs);
      }
    } catch (e) {
      if (e instanceof WorkdayHttpError && e.status === 422) {
        csrfQueue.push(target);
        return;
      }
      const status = axios.isAxiosError(e) ? e.response?.status : e instanceof WorkdayHttpError ? e.status : undefined;
      console.warn(`[ats] ${label}: ${status ? `HTTP ${status}` : e instanceof Error ? e.message : e}`);
    }
  });

  if (csrfQueue.length > 0) {
    console.log(`[ats] Workday: ${csrfQueue.length} tenant(s) need the CSRF path`);
    try {
      const pw = await pollWorkdayViaPlaywright(csrfQueue, now);
      results.push(...pw.postings);
      for (const [slug, f] of pw.discoveredFacets) discoveredFacets.set(slug, f);
      console.log(`[ats] Workday/Playwright: ${pw.postings.length} internships from ${csrfQueue.length} tenants`);
      saveWorkdayFlags({ confirmed: pw.confirmed, failed: pw.failed, facets: discoveredFacets });
    } catch (e) {
      console.warn(`[ats] Workday/Playwright batch failed: ${e instanceof Error ? e.message : e}`);
    }
  } else if (discoveredFacets.size > 0) {
    saveWorkdayFlags({ facets: discoveredFacets });
  }

  console.log(`[ats] Total: ${results.length} internships from ${targets.length} targets`);
  return results;
}
