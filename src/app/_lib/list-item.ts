import type { Internship } from "@/lib/types";

// Fields the list view reads. `description` is multi-KB per row and hidden
// from the UI, so it and the other unused fields are dropped from the payload.
export const LIST_FIELDS = [
  "id", "title", "company", "location", "link", "source",
  "postedAt", "seenAt", "score", "scoreLabel", "matchedKeywords",
  "applied", "hidden", "salaryText", "season",
] as const;

export type ListItem = Pick<Internship, (typeof LIST_FIELDS)[number]>;

export function pickListFields(i: Internship): ListItem {
  const out: Partial<ListItem> = {};
  for (const f of LIST_FIELDS) {
    if (i[f] !== undefined) (out as Record<string, unknown>)[f] = i[f];
  }
  return out as ListItem;
}
