// Reuse the canonical company-tier lists from the scorer config so the UI
// filter and notifier never drift from the scoring system's view of
// "elite" / "top". Matching uses the same tokenized+stemmed phrase match
// as the scorer (see keyword-match.ts) — so e.g. "Apple Inc." matches
// keyword "apple" but "Pineapple Express" does not.
import config from "../../data/scoring-config.json";
import { tokenize, matchesCompanyName } from "./keyword-match";

const ELITE = config.companyTiers?.elite?.companies ?? [];
const TOP   = config.companyTiers?.top?.companies   ?? [];
const SOLID = (config.companyTiers as Record<string, { companies?: string[] }>)?.solid?.companies ?? [];

// Pre-tokenize the tier lists once at module load — these lists are static
// and matchesAny gets called per row on every render.
const ELITE_TOKENS = ELITE.map((s: string) => tokenize(s));
const TOP_TOKENS   = TOP.map((s: string) => tokenize(s));
const SOLID_TOKENS = SOLID.map((s: string) => tokenize(s));

function matchesAny(company: string, tokenLists: string[][]): boolean {
  const tokens = tokenize(company);
  if (tokens.length === 0) return false;
  for (const needle of tokenLists) {
    if (matchesCompanyName(tokens, needle)) return true;
  }
  return false;
}

export function isElite(company: string): boolean {
  return matchesAny(company, ELITE_TOKENS);
}

export function isTopOrBetter(company: string): boolean {
  return matchesAny(company, ELITE_TOKENS) || matchesAny(company, TOP_TOKENS);
}

export function isSolidOrBetter(company: string): boolean {
  return isTopOrBetter(company) || matchesAny(company, SOLID_TOKENS);
}

export const ELITE_COUNT = ELITE.length;
export const TOP_COUNT = TOP.length;
export const SOLID_COUNT = SOLID.length;
