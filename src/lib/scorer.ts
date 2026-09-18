import fs from "node:fs";
import path from "node:path";
import type { Internship, ScoreLabel } from "./types";
import type { RoleType } from "./classify/posting";
import type { CompanyTier } from "./classify/company";
import { tokenize, containsPhrase } from "./keyword-match";

/**
 * score = companyBase[companyTier] × roleMultiplier[roleType] + location
 * bonus, capped at scoringCeiling. The company decides the band (an A is a
 * company worth applying to); the role scales it (a security analyst role at
 * an elite company is a C, not an A). Tiers come from the classifier; before
 * a row is classified the role is inferred from title keywords, and a
 * company named in companyTiers always overrides the classifier.
 */

interface Keywords { keywords: string[] }

export interface ScoringConfig {
  scoringCeiling: number;
  companyBase: Record<CompanyTier, number>;
  roleMultiplier: Record<RoleType, number>;
  /** Curated overrides by tier, including `other` to demote a company the model overrates. */
  companyTiers: Partial<Record<CompanyTier, { companies: string[] }>>;
  /** Title keywords per legacy tier; also feed matchedKeywords for the UI chips. */
  roleTiers: Record<string, Keywords & { points?: number }>;
  /** Legacy tier → roleType, used only before classification. */
  roleTierFallback: Record<string, RoleType>;
  locationBonus: Record<string, Keywords & { points: number }>;
}

const CONFIG_PATH = path.join(process.cwd(), "data", "scoring-config.json");
let _config: ScoringConfig | null = null;

export function loadConfig(): ScoringConfig {
  return (_config ??= JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as ScoringConfig);
}

export type Scorable = Pick<Internship, "title" | "company" | "location"> & Partial<Pick<Internship, "roleType" | "companyTier">>;

export interface ScoreResult {
  score: number;
  scoreLabel: ScoreLabel;
  roleType: RoleType;
  companyTier: CompanyTier;
  breakdown: { role: number; company: number; location: number };
  matchedKeywords: string[];
}

/**
 * The curated tier for a company name, or null when it is not listed. Names
 * arrive canonicalized (legal suffixes stripped), so a match is the whole
 * token sequence: "Snap" matches "Snap" but not "Snap Finance", "Sierra"
 * not "Sierra Nevada". Partial matches are left to the classifier.
 */
export function listedCompanyTier(company: string, cfg: ScoringConfig = loadConfig()): { tier: CompanyTier; name: string } | null {
  const key = tokenize(company).join(" ");
  if (!key) return null;
  for (const tier of ["elite", "top", "hot", "solid", "other"] as const) {
    for (const name of cfg.companyTiers[tier]?.companies ?? []) {
      if (tokenize(name).join(" ") === key) return { tier, name };
    }
  }
  return null;
}

function roleFromTitle(title: string, cfg: ScoringConfig, matched: string[]): RoleType {
  const tokens = tokenize(title);
  let best: RoleType = "other";
  let bestPts = -1;
  for (const [tier, info] of Object.entries(cfg.roleTiers)) {
    for (const kw of info.keywords) {
      if (!containsPhrase(tokens, tokenize(kw))) continue;
      matched.push(kw);
      const rt = cfg.roleTierFallback[tier] ?? "other";
      if (cfg.roleMultiplier[rt] > bestPts) { best = rt; bestPts = cfg.roleMultiplier[rt]; }
    }
  }
  return best;
}

function locationBonus(location: string, cfg: ScoringConfig, matched: string[]): number {
  if (!location) return 0;
  const tokens = tokenize(location);
  let best = 0;
  let bestKw: string | null = null;
  for (const info of Object.values(cfg.locationBonus)) {
    for (const kw of info.keywords) {
      if (containsPhrase(tokens, tokenize(kw)) && info.points > best) { best = info.points; bestKw = kw; }
    }
  }
  if (bestKw) matched.push(bestKw);
  return best;
}

export function labelFor(score: number): ScoreLabel {
  return score >= 75 ? "A" : score >= 60 ? "B" : score >= 45 ? "C" : score >= 25 ? "D" : "F";
}

export function scoreInternship(entry: Scorable, config?: ScoringConfig): ScoreResult {
  const cfg = config ?? loadConfig();
  const matched: string[] = [];

  // Title keywords always feed matchedKeywords (the UI's specialization chips
  // read them) even when the classifier already decided the role.
  const inferredRole = roleFromTitle(entry.title, cfg, matched);
  const roleType = entry.roleType ?? inferredRole;

  const listed = listedCompanyTier(entry.company, cfg);
  const companyTier: CompanyTier = listed?.tier ?? entry.companyTier ?? "other";
  if (listed) matched.push(listed.name);

  const company = cfg.companyBase[companyTier] ?? 0;
  const multiplier = cfg.roleMultiplier[roleType] ?? 0;
  const role = Math.round(company * multiplier);
  const location = role > 0 ? locationBonus(entry.location, cfg, matched) : 0;
  const score = Math.max(0, Math.min(role + location, cfg.scoringCeiling));

  return {
    score,
    scoreLabel: labelFor(score),
    roleType,
    companyTier,
    breakdown: { company, role: multiplier, location },
    matchedKeywords: [...new Set(matched)],
  };
}
