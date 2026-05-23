// Shared filter chain — applied by both the app's table filter
// (page.tsx) and the notifier's Discord push gate (poller/notifier.ts).
// Before this module each side had its own inline chain of ~8 predicates
// (tier / seasons / applied / hidden / sources / keywords / roles); a
// change to the tier semantic on one side never reached the other.
//
// FilterSpec declares every shared predicate as an optional field; each
// caller passes the subset it cares about. Predicates that are genuinely
// caller-specific (the app's free-text search and substring location;
// the notifier's classifyLocation-based non-US gate) stay inline at the
// call site — they aren't worth widening the shared interface for.
//
// Supersedes ADR-0002, which deferred this extraction. The trigger that
// flipped the call: the notifier grew its own chain that mirrored the
// app's, so the "page.tsx is the most-edited file" risk argument no
// longer applied — two call sites now share the maintenance burden, not
// one.

import { isElite, isTopOrBetter, isSolidOrBetter } from './tiers';
import { parseSeason } from './seasons';
import { postingMatchesAnyRole, type RoleId } from './role-taxonomy';

// Minimal structural shape the spec needs. Both the storage-side Internship
// (src/lib/types.ts) and the wire-side Internship (src/app/_lib/types.ts)
// satisfy this — they differ on whether matchedKeywords is required, and
// the spec only ever reads it as optional anyway.
export interface FilterablePosting {
  title?: string;
  company?: string;
  source: string;
  score: number | null;
  matchedKeywords?: string[];
  season?: string[];
  postedAt?: string;
  applied: boolean;
  hidden?: boolean;
}

export type TierFilter = 'all' | 'elite' | 'top-or-better' | 'solid-or-better';
export type AppliedFilter = 'all' | 'applied' | 'not-applied';

export interface FilterSpec {
  /** 'elite' or 'top-or-better' restricts to those tiers; 'all' (or omit) = no gate. */
  tier?: TierFilter;
  /** Pass if any of the posting's season tokens appear in this list. Empty = no gate. */
  seasons?: string[];
  /** 'applied' = only applied; 'not-applied' = only unapplied; 'all' (or omit) = no gate. */
  appliedFilter?: AppliedFilter;
  /** If true, drop postings marked hidden. */
  excludeHidden?: boolean;
  /** Pass if posting source is in this list. Empty = no gate. */
  includeSources?: string[];
  /** Fail if posting source is in this list. Empty = no gate. */
  excludeSources?: string[];
  /** Pass if posting's matchedKeywords contains any of these (case-insensitive). */
  includeKeywords?: string[];
  /** Fail if posting's matchedKeywords contains any of these (case-insensitive). */
  excludeKeywords?: string[];
  /** Pass if posting matches any of these roles (postingMatchesAnyRole semantics). */
  roles?: readonly RoleId[];
  /** Posting must have score ≥ this value. 0 = no gate. */
  minScore?: number;
  /** Posting's postedAt must be ≥ this ms-epoch timestamp. */
  postedAfter?: number;
}

/**
 * Returns true if the internship passes every active filter in `spec`.
 * Each predicate is skipped when its field is undefined or its array is
 * empty — the spec is intentionally additive, not "all must be set."
 */
export function applyFilterSpec(i: FilterablePosting, spec: FilterSpec): boolean {
  if (spec.tier === 'elite' && !isElite(i.company ?? '')) return false;
  if (spec.tier === 'top-or-better' && !isTopOrBetter(i.company ?? '')) return false;
  if (spec.tier === 'solid-or-better' && !isSolidOrBetter(i.company ?? '')) return false;

  if (spec.seasons && spec.seasons.length > 0) {
    const tokens = i.season ?? parseSeason(i.title ?? '');
    if (!tokens.some(t => spec.seasons!.includes(t))) return false;
  }

  if (spec.appliedFilter === 'applied' && !i.applied) return false;
  if (spec.appliedFilter === 'not-applied' && i.applied) return false;
  if (spec.excludeHidden && i.hidden) return false;

  if (spec.includeSources && spec.includeSources.length > 0) {
    if (!spec.includeSources.includes(i.source)) return false;
  }
  if (spec.excludeSources && spec.excludeSources.length > 0) {
    if (i.source && spec.excludeSources.includes(i.source)) return false;
  }

  if (spec.minScore != null && spec.minScore > 0 && (i.score ?? 0) < spec.minScore) {
    return false;
  }

  if (spec.postedAfter != null) {
    const posted = new Date(i.postedAt ?? 0).getTime();
    if (!Number.isFinite(posted) || posted < spec.postedAfter) return false;
  }

  const hasIncludeKw = spec.includeKeywords && spec.includeKeywords.length > 0;
  const hasExcludeKw = spec.excludeKeywords && spec.excludeKeywords.length > 0;
  if (hasIncludeKw || hasExcludeKw) {
    const kws = (i.matchedKeywords ?? []).map(k => k.toLowerCase());
    if (hasIncludeKw) {
      const need = spec.includeKeywords!.map(k => k.toLowerCase());
      if (!need.some(k => kws.includes(k))) return false;
    }
    if (hasExcludeKw) {
      const ban = spec.excludeKeywords!.map(k => k.toLowerCase());
      if (ban.some(k => kws.includes(k))) return false;
    }
  }

  if (spec.roles && spec.roles.length > 0) {
    if (!postingMatchesAnyRole(i.matchedKeywords ?? [], spec.roles)) return false;
  }

  return true;
}
