"use client";

// Orchestrates the spreadsheet list view: column headers + flat rows, OR
// collapsible per-company sections when groupByCompany is on. Both modes
// reuse the same InternshipRow for visual consistency.

import { companyKey } from "@/lib/company-key";
import { useState, memo } from "react";
import { ChevronRight } from "lucide-react";
import type { Internship, SortBy } from "../_lib/types";
import { InternshipRow, LIST_GRID_COLS } from "./InternshipRow";
import { listedAt } from "@/lib/filter-spec";

// Headers in display order. The `mobileHidden` entries collapse below md
// but their grid cells still exist so column widths line up across rows.
// `sortKey` lets us render a sort-direction indicator next to the column
// currently driving the order.
const COL_HEADERS: Array<{ label: string; mobileHidden?: boolean; sortKey?: SortBy }> = [
  { label: "Score", sortKey: "score" },
  { label: "Company" },
  { label: "Title", mobileHidden: true },
  { label: "Salary", mobileHidden: true },
  { label: "Location", mobileHidden: true },
  { label: "Season", mobileHidden: true },
  { label: "Posted", sortKey: "posted" },
  { label: "Verified", mobileHidden: true },
  { label: "" },
];

interface Props {
  // Flat (ungrouped) list mode: the paginated row slice to render.
  items: Internship[];
  // Grouped mode: pre-built, pre-paginated company sections. Non-null switches
  // the component into grouped rendering; null renders the flat `items` list.
  // Grouping + group-level pagination happen in the page so a company's roles
  // never split across pages.
  groups: Group[] | null;
  sortBy: SortBy;
}

export interface Group {
  company: string;
  items: Internship[];
  avgScore: number;
}

const latestPostedAt = (roles: Internship[]): number =>
  roles.reduce((max, r) => Math.max(max, new Date(listedAt(r)).getTime()), 0);

// Display casing for a company whose roles may carry slightly different
// casings ("Quadric" vs "QUADRIC" — ingestion canonicalizes legal suffixes but
// not intentional caps). Most frequent casing wins; ties prefer the variant
// with fewer uppercase letters (favours proper-case over a shouty ALL-CAPS
// board listing), then lexicographic for determinism.
function pickDisplayCasing(counts: Map<string, number>): string {
  const upper = (s: string) => (s.match(/[A-Z]/g) ?? []).length;
  return [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (upper(a[0]) !== upper(b[0])) return upper(a[0]) - upper(b[0]);
    return a[0] < b[0] ? -1 : 1;
  })[0][0];
}

// Group internships by company, then order the company sections to match the
// active sort: by most-recently-posted role under "posted", by average score
// otherwise. Roles within a company keep their incoming order, which is already
// sort-correct because callers pass an already-sorted list. Grouping uses the
// normalized company key so spelling variants (Datology / DatologyAI) share
// one section; the header shows the most common spelling.
export function groupInternships(items: Internship[], sortBy: SortBy): Group[] {
  const map = new Map<string, { roles: Internship[]; casings: Map<string, number> }>();
  for (const i of items) {
    const display = i.company || "Unknown";
    const k = companyKey(display) || display.toLowerCase();
    let entry = map.get(k);
    if (!entry) { entry = { roles: [], casings: new Map() }; map.set(k, entry); }
    entry.roles.push(i);
    entry.casings.set(display, (entry.casings.get(display) ?? 0) + 1);
  }
  const groups: Group[] = [];
  for (const { roles, casings } of map.values()) {
    const company = pickDisplayCasing(casings);
    const totalScore = roles.reduce((s, r) => s + (r.score ?? 0), 0);
    groups.push({
      company,
      items: roles,
      avgScore: roles.length > 0 ? Math.round(totalScore / roles.length) : 0,
    });
  }
  if (sortBy === "posted") {
    // Decorate-sort: compute each company's latest posting once, not on every
    // comparison. avgScore is already a precomputed field, so the score branch
    // needs no such treatment.
    return groups
      .map((g) => ({ g, ts: latestPostedAt(g.items) }))
      .sort((a, b) => b.ts - a.ts)
      .map((d) => d.g);
  }
  groups.sort((a, b) => b.avgScore - a.avgScore);
  return groups;
}

function ColumnHeader({ sortBy }: { sortBy: SortBy }): React.JSX.Element {
  return (
    <div
      className={`grid ${LIST_GRID_COLS} items-center gap-2 md:gap-3 px-2.5 md:px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-white/45 border-b border-white/[0.06]`}
    >
      {COL_HEADERS.map(({ label, mobileHidden, sortKey }, i) => {
        // Active column gets a brighter text tone. No direction chevron —
        // sort isn't toggleable in the header (only via the sort selector
        // up top), and both modes always run descending, so a "descending"
        // arrow next to the column implied a control that doesn't exist.
        const active = sortKey != null && sortKey === sortBy;
        return (
          <span
            key={i}
            className={`items-center gap-0.5 ${mobileHidden ? "hidden md:inline-flex" : "inline-flex"} ${
              i === COL_HEADERS.length - 1 ? "justify-self-end" : ""
            } ${active ? "text-white/75" : ""}`}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

function InternshipListImpl({ items, groups, sortBy }: Props) {
  if (groups === null) {
    return (
      <div className="flex flex-col gap-0.5">
        <ColumnHeader sortBy={sortBy} />
        {items.map((item) => <InternshipRow key={item.id} item={item} />)}
      </div>
    );
  }
  return <GroupedList groups={groups} sortBy={sortBy} />;
}

export const InternshipList = memo(InternshipListImpl);

function GroupedList({ groups, sortBy }: { groups: Group[]; sortBy: SortBy }): React.JSX.Element {
  // Every group renders a section header — including single-role companies —
  // and they all start expanded. User can collapse any of them via the header.
  const [closed, setClosed] = useState<Set<string>>(new Set());

  function toggle(company: string): void {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(company)) next.delete(company);
      else next.add(company);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <ColumnHeader sortBy={sortBy} />
      {groups.map((g) => {
        const open = !closed.has(g.company);
        return (
          <div key={g.company} className="rounded border border-white/[0.06] bg-white/[0.015]">
            <button
              onClick={() => toggle(g.company)}
              aria-expanded={open}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.03] transition-colors text-left"
            >
              <ChevronRight
                className={`h-3.5 w-3.5 text-white/45 transition-transform ${open ? "rotate-90" : ""}`}
              />
              <span className="font-semibold text-white text-[13px]">{g.company}</span>
              <span className="text-[11px] text-white/50 tabular-nums">
                {g.items.length} role{g.items.length !== 1 ? "s" : ""}
              </span>
              <span className="text-[11px] text-white/45 tabular-nums">avg {g.avgScore}</span>
            </button>
            {open && (
              <div className="flex flex-col gap-0.5 px-1 pb-1.5">
                {g.items.map((item) => <InternshipRow key={item.id} item={item} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
