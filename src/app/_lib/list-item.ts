import type { Internship } from "@/lib/types";

// Allowlist of fields the list view + its external consumer
// (src/poller/scripts/find-ats-links-daily.ts: id/title/company/link)
// actually read. Everything else — notably `description` (multi-KB per
// row, hidden from the UI), the numeric salary fields, and `isNew` — is
// dropped from the list payload to keep transfer/parse cheap as the
// corpus grows.
export const LIST_FIELDS = [
  "id", "title", "company", "location", "link", "source",
  "postedAt", "seenAt", "score", "scoreLabel", "matchedKeywords",
  "applied", "hidden", "salaryText", "season",
] as const;

export type ListItem = Pick<Internship, (typeof LIST_FIELDS)[number]>;

/** Project a storage Internship down to the list-view allowlist. */
export function pickListFields(i: Internship): ListItem {
  const out = {} as Record<string, unknown>;
  for (const f of LIST_FIELDS) {
    if (i[f] !== undefined) out[f] = i[f];
  }
  return out as ListItem;
}
