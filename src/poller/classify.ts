import type { Internship } from '../lib/types';
import { classifierConfigured } from '../lib/classify/provider';
import { classifyCompany, type CompanyTier } from '../lib/classify/company';
import { classifyPosting, TECHNICAL_ROLE_TYPES, type PostingClassification } from '../lib/classify/posting';
import { scoreInternship, listedCompanyTier } from '../lib/scorer';
import { getCompanyProfiles, saveCompanyProfile, saveClassification, archiveInternshipsByIds } from '../lib/store';
import { pool } from '../lib/concurrency';

export const companyKey = (company: string): string => company.trim().toLowerCase();

export interface ClassifyOutcome {
  /** Rows that were classified and remain active. */
  kept: Internship[];
  archived: number;
  failed: number;
  skipped: boolean;
}

/** Why a classified row leaves the corpus, or null to keep it. */
export function archiveReason(c: PostingClassification): string | null {
  if (!c.isInternship) return 'not an internship';
  if (c.usEligible === 'no') return 'outside the US';
  if (!TECHNICAL_ROLE_TYPES.includes(c.roleType)) return `role ${c.roleType}`;
  return null;
}

/**
 * Judge each company once (cached in company_profiles; curated tiers skip the
 * model) and each posting once, then rescore and archive what a CS tracker
 * should not show. Rows whose classification fails are left unclassified for
 * the next run.
 */
export async function classifyRows(rows: Internship[]): Promise<ClassifyOutcome> {
  if (rows.length === 0) return { kept: [], archived: 0, failed: 0, skipped: false };
  if (!classifierConfigured()) {
    console.log('[classify] ANTHROPIC_API_KEY not set; rows keep their keyword-based scores');
    return { kept: rows, archived: 0, failed: 0, skipped: true };
  }

  const tiers = await resolveCompanyTiers(rows);

  const kept: Internship[] = [];
  const toArchive: string[] = [];
  let failed = 0;

  await pool(rows, 6, async (row) => {
    let c: PostingClassification;
    try {
      c = await classifyPosting({ title: row.title, company: row.company, location: row.location, description: row.description });
    } catch (e) {
      failed++;
      console.warn(`[classify] posting ${row.id} failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    const companyTier = tiers.get(companyKey(row.company)) ?? 'other';
    const s = scoreInternship({ title: row.title, company: row.company, location: row.location, roleType: c.roleType, companyTier });
    await saveClassification(row.id, { ...c, companyTier: s.companyTier, score: s.score, scoreLabel: s.scoreLabel, matchedKeywords: s.matchedKeywords });
    const updated: Internship = { ...row, ...c, companyTier: s.companyTier, score: s.score, scoreLabel: s.scoreLabel, matchedKeywords: s.matchedKeywords };
    if (archiveReason(c)) toArchive.push(row.id);
    else kept.push(updated);
  });

  const archived = await archiveInternshipsByIds(toArchive);
  console.log(`[classify] ${rows.length} rows: kept ${kept.length}, archived ${archived}, failed ${failed}`);
  return { kept, archived, failed, skipped: false };
}

/** Company tier per company key, classifying unseen companies with the model. */
export async function resolveCompanyTiers(rows: Internship[]): Promise<Map<string, CompanyTier>> {
  const byKey = new Map<string, Internship>();
  for (const r of rows) if (!byKey.has(companyKey(r.company))) byKey.set(companyKey(r.company), r);

  const tiers = new Map<string, CompanyTier>();
  const profiles = await getCompanyProfiles([...byKey.keys()]);
  const pending: Array<[string, Internship]> = [];
  for (const [key, row] of byKey) {
    const listed = listedCompanyTier(row.company);
    if (listed) {
      tiers.set(key, listed.tier);
      if (!profiles.has(key)) await saveCompanyProfile(key, row.company, { tier: listed.tier, sector: '', known: true, reason: 'curated list' }, 'curated');
    } else if (profiles.has(key)) {
      tiers.set(key, profiles.get(key)!.tier);
    } else {
      pending.push([key, row]);
    }
  }

  let classified = 0;
  await pool(pending, 4, async ([key, row]) => {
    try {
      const atsHost = (() => { try { return new URL(row.link).hostname; } catch { return undefined; } })();
      const profile = await classifyCompany({ company: row.company, atsHost, sampleTitle: row.title });
      await saveCompanyProfile(key, row.company, profile, process.env.CLASSIFY_COMPANY_MODEL || 'claude-sonnet-4-6');
      tiers.set(key, profile.tier);
      classified++;
    } catch (e) {
      console.warn(`[classify] company "${row.company}" failed: ${e instanceof Error ? e.message : e}`);
    }
  });
  if (classified > 0) console.log(`[classify] Judged ${classified} new compan${classified === 1 ? 'y' : 'ies'}`);
  return tiers;
}
