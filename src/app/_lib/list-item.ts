import type { Internship } from "@/lib/types";

// Fields the list view reads. `description` is multi-KB per row and hidden
// from the UI, so it and the other unused fields are dropped from the payload.
export const LIST_FIELDS = [
  "id", "title", "company", "location", "link", "source",
  "postedAt", "seenAt", "firstSeenAt", "score", "scoreLabel", "salaryText", "season",
  "roleType", "degrees", "companyTier", "locations", "metros",
] as const satisfies ReadonlyArray<keyof Internship>;

export type ListItem = Pick<Internship, (typeof LIST_FIELDS)[number]>;

export function pickListFields(i: Internship): ListItem {
  return Object.fromEntries(LIST_FIELDS.map(f => [f, i[f]])) as ListItem;
}
