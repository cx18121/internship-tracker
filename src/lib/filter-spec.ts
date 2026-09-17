// Shared filter chain applied by both the app's table filter and the
// notifier's Discord gate. FilterSpec declares every shared predicate as an
// optional field; each caller passes the subset it cares about.

import { isElite, isTopOrBetter, isSolidOrBetter } from './tiers';
import { postingMatchesAnyRole, type RoleId } from './role-taxonomy';
import type { Internship } from './types';
import type { RoleType, Degree } from './classify/posting';

/** The fields a filter reads. Satisfied by a stored Internship and by the list-view payload. */
export type Filterable = Pick<Internship, 'company' | 'title' | 'source' | 'season' | 'applied' | 'hidden'> &
  Partial<Pick<Internship, 'score' | 'postedAt' | 'matchedKeywords' | 'companyTier' | 'roleType' | 'degrees'>>;

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
  /** Pass if the classified role type is one of these. Empty = no gate. */
  roleTypes?: readonly RoleType[];
  /** Pass if any eligible degree is listed; 'unknown' matches rows with no degree signal. */
  degrees?: readonly (Degree | 'unknown')[];
}

/**
 * Returns true if the internship passes every active filter in `spec`.
 * Each predicate is skipped when its field is undefined or its array is
 * empty — the spec is intentionally additive, not "all must be set."
 */
export function applyFilterSpec(i: Filterable, spec: FilterSpec): boolean {
  if (spec.tier === 'elite' && !isElite(i.companyTier)) return false;
  if (spec.tier === 'top-or-better' && !isTopOrBetter(i.companyTier)) return false;
  if (spec.tier === 'solid-or-better' && !isSolidOrBetter(i.companyTier)) return false;

  if (spec.roleTypes && spec.roleTypes.length > 0 && !spec.roleTypes.includes(i.roleType ?? 'other')) return false;
  if (spec.degrees && spec.degrees.length > 0) {
    const d = i.degrees ?? [];
    const ok = d.length === 0 ? spec.degrees.includes('unknown') : d.some(x => spec.degrees!.includes(x));
    if (!ok) return false;
  }

  if (spec.seasons && spec.seasons.length > 0 && !i.season.some(t => spec.seasons!.includes(t))) return false;

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
