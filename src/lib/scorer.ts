import fs from "fs";
import path from "path";
import type { Internship } from "./types";
import { tokenize, containsPhrase } from "./keyword-match";

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface TieredKeywords { points: number; keywords: string[] }
interface CompanyTier   { points: number; companies: string[] }

export interface ScoringConfig {
  scoringCeiling: number;
  companyTiers: Record<string, CompanyTier>;
  roleTiers: Record<string, TieredKeywords>;
  locationBonus: Record<string, TieredKeywords>;
}

const CONFIG_PATH = path.join(process.cwd(), "data", "scoring-config.json");
let _config: ScoringConfig | null = null;

function loadConfig(): ScoringConfig {
  if (!_config) {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    _config = JSON.parse(raw) as ScoringConfig;
  }
  return _config;
}

/**
 * Clear the cached config. Test helper — production code should not call this.
 * After clearing, the next `loadConfig()` re-reads the file.
 */
export function _resetConfigCache(): void {
  _config = null;
}

// ---------------------------------------------------------------------------
// Per-component scoring
// ---------------------------------------------------------------------------
// Matching uses tokenize+containsPhrase from keyword-match.ts — see there
// for stemming rules and rationale. Sharing the matcher with tiers.ts keeps
// the UI filter aligned with what the scorer actually counted.

function scoreRole(title: string, config: ScoringConfig, matched: string[]): number {
  if (!title) return 0;
  const tokens = tokenize(title);
  for (const tier of Object.keys(config.roleTiers)) {
    const info = config.roleTiers[tier];
    for (const kw of info.keywords) {
      if (containsPhrase(tokens, tokenize(kw))) {
        matched.push(kw);
        return info.points;
      }
    }
  }
  return 0;
}

function scoreCompany(company: string, config: ScoringConfig, matched: string[]): number {
  if (!company) return 0;
  const tokens = tokenize(company);
  for (const tier of Object.keys(config.companyTiers)) {
    const info = config.companyTiers[tier];
    for (const name of info.companies) {
      if (containsPhrase(tokens, tokenize(name))) {
        matched.push(name);
        return info.points;
      }
    }
  }
  return 0;
}

function scoreLocation(location: string, config: ScoringConfig, matched: string[]): number {
  if (!location) return 0;
  const tokens = tokenize(location);
  let best = 0;
  let bestKw: string | null = null;
  for (const tier of Object.keys(config.locationBonus)) {
    const info = config.locationBonus[tier];
    for (const kw of info.keywords) {
      if (containsPhrase(tokens, tokenize(kw))) {
        if (info.points > best) { best = info.points; bestKw = kw; }
        break;
      }
    }
  }
  if (bestKw) matched.push(bestKw);
  return best;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  role: number;
  company: number;
  location: number;
}

export interface ScoreResult {
  score: number;
  scoreLabel: 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: ScoreBreakdown;
  matchedKeywords: string[];
}

/**
 * Score an internship against the scoring config.
 *
 * @param entry  The internship to score (only title/company/description/location are read).
 * @param config Optional config override — defaults to the cached load of
 *               data/scoring-config.json. Tests pass a synthetic config here
 *               to verify tier boundaries without touching the filesystem.
 */
export function scoreInternship(entry: Partial<Internship>, config?: ScoringConfig): ScoreResult {
  const cfg = config ?? loadConfig();
  const title = entry.title ?? '';
  const company = entry.company ?? '';
  const matched: string[] = [];

  const role = scoreRole(title, cfg, matched);
  const coPts = scoreCompany(company, cfg, matched);
  const loc = scoreLocation(entry.location ?? '', cfg, matched);

  const raw = role + coPts + loc;
  const score = Math.max(0, Math.min(raw, cfg.scoringCeiling));

  let scoreLabel: ScoreResult['scoreLabel'];
  if      (score >= 75) scoreLabel = 'A';
  else if (score >= 60) scoreLabel = 'B';
  else if (score >= 45) scoreLabel = 'C';
  else if (score >= 25) scoreLabel = 'D';
  else                  scoreLabel = 'F';

  return {
    score,
    scoreLabel,
    breakdown: { role, company: coPts, location: loc },
    matchedKeywords: Array.from(new Set(matched)),
  };
}
