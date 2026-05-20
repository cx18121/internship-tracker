import fs from "fs";
import path from "path";
import type { Internship } from "./types";

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface TieredKeywords { points: number; keywords: string[] }
interface CompanyTier   { points: number; companies: string[] }

interface ScoringConfig {
  scoringCeiling: number;
  companyTiers: Record<string, CompanyTier>;
  roleTiers: Record<string, TieredKeywords>;
  techStack: Record<string, TieredKeywords>;
  techStackCap: number;
  domainSignals?: { pointsEach: number; cap: number; keywords: string[] };
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

// ---------------------------------------------------------------------------
// Per-component scoring
// ---------------------------------------------------------------------------

function scoreRole(title: string, config: ScoringConfig, matched: string[]): number {
  if (!title) return 0;
  const lower = title.toLowerCase();
  for (const tier of Object.keys(config.roleTiers)) {
    const info = config.roleTiers[tier];
    for (const kw of info.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        matched.push(kw);
        return info.points;
      }
    }
  }
  return 0;
}

function scoreCompany(company: string, config: ScoringConfig, matched: string[]): number {
  if (!company) return 0;
  const lower = company.toLowerCase().trim();
  for (const tier of Object.keys(config.companyTiers)) {
    const info = config.companyTiers[tier];
    for (const name of info.companies) {
      const n = name.toLowerCase();
      if (lower === n || lower.includes(n) || n.includes(lower)) {
        matched.push(name);
        return info.points;
      }
    }
  }
  return 0;
}

function scoreTech(text: string, config: ScoringConfig, matched: string[]): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let pts = 0;
  // Iterate high → medium → low; collect matched keywords up to the cap.
  for (const level of Object.keys(config.techStack)) {
    const info = config.techStack[level];
    for (const kw of info.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        matched.push(kw);
        pts += info.points;
        if (pts >= config.techStackCap) return config.techStackCap;
      }
    }
  }
  return Math.min(pts, config.techStackCap);
}

function scoreDomain(text: string, config: ScoringConfig, matched: string[]): number {
  if (!text || !config.domainSignals) return 0;
  const lower = text.toLowerCase();
  let pts = 0;
  for (const kw of config.domainSignals.keywords) {
    if (lower.includes(kw.toLowerCase())) {
      matched.push(kw);
      pts += config.domainSignals.pointsEach;
      if (pts >= config.domainSignals.cap) return config.domainSignals.cap;
    }
  }
  return pts;
}

function scoreLocation(location: string, config: ScoringConfig, matched: string[]): number {
  if (!location) return 0;
  const lower = location.toLowerCase();
  let best = 0;
  let bestKw: string | null = null;
  for (const tier of Object.keys(config.locationBonus)) {
    const info = config.locationBonus[tier];
    for (const kw of info.keywords) {
      if (lower.includes(kw.toLowerCase())) {
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
  tech: number;
  domain: number;
  location: number;
}

export interface ScoreResult {
  score: number;
  scoreLabel: 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: ScoreBreakdown;
  matchedKeywords: string[];
}

export function scoreInternship(entry: Partial<Internship>): ScoreResult {
  const config = loadConfig();
  const title = entry.title ?? '';
  const company = entry.company ?? '';
  const description = entry.description ?? '';
  const matched: string[] = [];

  const role = scoreRole(title, config, matched);
  const coPts = scoreCompany(company, config, matched);
  // Tech keywords can appear in either title or description.
  const tech = scoreTech(`${title} ${description}`, config, matched);
  // Domain signals are usually only in the description.
  const domain = scoreDomain(description, config, matched);
  const loc = scoreLocation(entry.location ?? '', config, matched);

  const raw = role + coPts + tech + domain + loc;
  const score = Math.max(0, Math.min(raw, config.scoringCeiling));

  let scoreLabel: ScoreResult['scoreLabel'];
  if      (score >= 75) scoreLabel = 'A';
  else if (score >= 60) scoreLabel = 'B';
  else if (score >= 45) scoreLabel = 'C';
  else if (score >= 25) scoreLabel = 'D';
  else                  scoreLabel = 'F';

  return {
    score,
    scoreLabel,
    breakdown: { role, company: coPts, tech, domain, location: loc },
    // Dedupe — a single keyword can appear in multiple tier buckets
    // (e.g. "llm" is in both roleTiers.T1 and techStack.high), and each
    // scoreXxx() helper pushes independently.
    matchedKeywords: Array.from(new Set(matched)),
  };
}
