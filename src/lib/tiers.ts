import type { CompanyTier } from "./classify/company";

/** Ordering used by the tier filter. `hot` sits with `top`: both are worth applying to. */
const RANK: Record<CompanyTier, number> = { elite: 3, top: 2, hot: 2, solid: 1, other: 0 };

export function isElite(tier: CompanyTier | undefined): boolean { return (tier ? RANK[tier] : 0) >= 3; }
export function isTopOrBetter(tier: CompanyTier | undefined): boolean { return (tier ? RANK[tier] : 0) >= 2; }
export function isSolidOrBetter(tier: CompanyTier | undefined): boolean { return (tier ? RANK[tier] : 0) >= 1; }
