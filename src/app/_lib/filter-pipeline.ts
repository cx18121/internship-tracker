import type { Internship, AppliedFilter, TierFilter, SortBy } from "./types";
import type { RoleId } from "@/lib/role-taxonomy";
import { applyFilterSpec } from "@/lib/filter-spec";

export interface LocalPredicateInput {
  searchLower: string;
  selectedLocations: string[];
  locationText: string;
}

// Free-text search + substring location — the app-only predicates that are
// NOT part of the shared filter spec. Mirrors page.tsx's prior inline block
// verbatim so the season-count and tab-count derivations stay consistent.
export function passesLocalPredicates(i: Internship, p: LocalPredicateInput): boolean {
  if (p.searchLower) {
    const hay = `${i.company} ${i.title} ${i.location ?? ""}`.toLowerCase();
    if (!hay.includes(p.searchLower)) return false;
  }
  if (p.selectedLocations.length > 0 || p.locationText) {
    const loc = i.location.toLowerCase();
    const locMatch = p.selectedLocations.some((l) => loc.includes(l.toLowerCase()));
    const textMatch = p.locationText ? loc.includes(p.locationText.toLowerCase()) : false;
    if (!locMatch && !textMatch && !(p.selectedLocations.length === 0)) return false;
    if (p.selectedLocations.length === 0 && p.locationText && !textMatch) return false;
  }
  return true;
}

export interface FilterCriteria extends LocalPredicateInput {
  tier: TierFilter;
  seasons: string[];
  appliedFilter: AppliedFilter;
  showHidden: boolean;
  selectedSources: string[];
  minScore: number;
  windowCutoff: number | null;
  includeKeywords: string[];
  excludeKeywords: string[];
  selectedRoles: RoleId[];
  sortBy: SortBy;
}

export function filterAndSortInternships(
  internships: Internship[],
  c: FilterCriteria,
): Internship[] {
  return internships
    .filter((i) => {
      if (!passesLocalPredicates(i, c)) return false;
      return applyFilterSpec(i, {
        tier: c.tier,
        seasons: c.seasons,
        appliedFilter: c.appliedFilter,
        excludeHidden: !c.showHidden,
        includeSources: c.selectedSources,
        minScore: c.minScore,
        postedAfter: c.windowCutoff ?? undefined,
        includeKeywords: c.includeKeywords,
        excludeKeywords: c.excludeKeywords,
        roles: c.selectedRoles,
      });
    })
    .sort((a, b) => {
      if (c.sortBy === "posted") {
        return new Date(b.postedAt ?? 0).getTime() - new Date(a.postedAt ?? 0).getTime();
      }
      return (b.score ?? -1) - (a.score ?? -1);
    });
}
