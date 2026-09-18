// Shared filter chain applied by both the app's table filter and the
// notifier's Discord gate. Each predicate is skipped when its field is
// undefined or its array is empty.

import { isElite, isTopOrBetter, isSolidOrBetter } from './tiers';
import type { Internship } from './types';
import type { RoleType, Degree } from './classify/posting';
import type { Metro } from './metros';

/** The fields a filter reads. Satisfied by a stored Internship and by the list-view payload. */
export type Filterable = Pick<Internship, 'company' | 'title' | 'source' | 'season' | 'firstSeenAt'> &
  Partial<Pick<Internship, 'score' | 'postedAt' | 'companyTier' | 'roleType' | 'degrees' | 'metros'>>;

/** The date a posting is listed under: the source's publication date, or when the tracker first saw it. */
export function listedAt(i: Pick<Filterable, 'postedAt' | 'firstSeenAt'>): string {
  return i.postedAt ?? i.firstSeenAt;
}

export type TierFilter = 'all' | 'elite' | 'top-or-better' | 'solid-or-better';
export type DegreeFilter = Degree | 'unknown';

export interface FilterSpec {
  tier?: TierFilter;
  /** Pass if any of the posting's season tokens appear in this list. */
  seasons?: readonly string[];
  includeSources?: readonly string[];
  excludeSources?: readonly string[];
  /** Posting must have score ≥ this value. 0 = no gate. */
  minScore?: number;
  /** listedAt(posting) must be ≥ this ms-epoch timestamp. */
  postedAfter?: number;
  roleTypes?: readonly RoleType[];
  /** 'unknown' matches rows with no degree signal. */
  degrees?: readonly DegreeFilter[];
  /** Pass if any of the posting's metros is listed. */
  metros?: readonly Metro[];
}

export function applyFilterSpec(i: Filterable, spec: FilterSpec): boolean {
  if (spec.tier === 'elite' && !isElite(i.companyTier)) return false;
  if (spec.tier === 'top-or-better' && !isTopOrBetter(i.companyTier)) return false;
  if (spec.tier === 'solid-or-better' && !isSolidOrBetter(i.companyTier)) return false;

  if (spec.seasons?.length && !i.season.some(t => spec.seasons!.includes(t))) return false;
  if (spec.includeSources?.length && !spec.includeSources.includes(i.source)) return false;
  if (spec.excludeSources?.length && spec.excludeSources.includes(i.source)) return false;
  if (spec.minScore && (i.score ?? 0) < spec.minScore) return false;

  if (spec.postedAfter != null) {
    const posted = new Date(listedAt(i)).getTime();
    if (!Number.isFinite(posted) || posted < spec.postedAfter) return false;
  }

  if (spec.roleTypes?.length && !spec.roleTypes.includes(i.roleType ?? 'other')) return false;
  if (spec.metros?.length && !(i.metros ?? []).some(m => spec.metros!.includes(m))) return false;
  if (spec.degrees?.length) {
    const d = i.degrees ?? [];
    if (d.length === 0 ? !spec.degrees.includes('unknown') : !d.some(x => spec.degrees!.includes(x))) return false;
  }
  return true;
}
