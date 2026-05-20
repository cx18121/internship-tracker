// Reuse the canonical company-tier lists from the scorer config so the UI
// filter and notifier never drift from the scoring system's view of
// "elite" / "top". Matching mirrors src/lib/scorer.ts: case-insensitive,
// bidirectional substring (covers "Apple" vs "Apple Inc.", etc.).
import config from "../../data/scoring-config.json";

const ELITE = (config.companyTiers?.elite?.companies ?? []).map((s: string) => s.toLowerCase());
const TOP   = (config.companyTiers?.top?.companies ?? []).map((s: string) => s.toLowerCase());

function matchesAny(company: string, list: string[]): boolean {
  const lower = company.toLowerCase().trim();
  if (!lower) return false;
  for (const name of list) {
    if (lower === name || lower.includes(name) || name.includes(lower)) return true;
  }
  return false;
}

export function isElite(company: string): boolean {
  return matchesAny(company, ELITE);
}

export function isTopOrBetter(company: string): boolean {
  return matchesAny(company, ELITE) || matchesAny(company, TOP);
}

export const ELITE_COUNT = ELITE.length;
export const TOP_COUNT = TOP.length;
