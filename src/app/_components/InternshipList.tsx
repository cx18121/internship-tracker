"use client";

// Orchestrates the spreadsheet list view: column headers + flat rows, OR
// collapsible per-company sections when groupByCompany is on. Both modes
// reuse the same InternshipRow for visual consistency.

import { useState, memo } from "react";
import { ChevronRight } from "lucide-react";
import type { Internship, SortBy } from "../_lib/types";
import { InternshipRow, LIST_GRID_COLS } from "./InternshipRow";

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
  pendingIds: Set<string>;
  onToggleApplied: (id: string, current: boolean) => void;
  onHide: (id: string, hidden: boolean) => void;
  isOwner: boolean;
}

export interface Group {
  company: string;
  items: Internship[];
  avgScore: number;
  appliedCount: number;
}

const latestPostedAt = (roles: Internship[]): number =>
  roles.reduce((max, r) => Math.max(max, new Date(r.postedAt ?? 0).getTime()), 0);

// Group internships by company, then order the company sections to match the
// active sort: by most-recently-posted role under "posted", by average score
// otherwise. Roles within a company keep their incoming order, which is already
// sort-correct because callers pass an already-sorted list.
export function groupInternships(items: Internship[], sortBy: SortBy): Group[] {
  const map = new Map<string, Internship[]>();
  for (const i of items) {
    const k = i.company || "Unknown";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(i);
  }
  const groups: Group[] = [];
  for (const [company, roles] of map.entries()) {
    const totalScore = roles.reduce((s, r) => s + (r.score ?? 0), 0);
    groups.push({
      company,
      items: roles,
      avgScore: roles.length > 0 ? Math.round(totalScore / roles.length) : 0,
      appliedCount: roles.filter((r) => r.applied).length,
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
            className={`inline-flex items-center gap-0.5 ${mobileHidden ? "hidden md:inline-flex" : ""} ${
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

function InternshipListImpl({
  items,
  groups,
  sortBy,
  pendingIds,
  onToggleApplied,
  onHide,
  isOwner,
}: Props) {
  if (groups === null) {
    return (
      <div className="flex flex-col gap-0.5">
        <ColumnHeader sortBy={sortBy} />
        {items.map((item) => (
          <InternshipRow
            key={item.id}
            item={item}
            pending={pendingIds.has(item.id)}
            onToggleApplied={onToggleApplied}
            onHide={onHide}
            isOwner={isOwner}
          />
        ))}
      </div>
    );
  }

  // Grouped mode — render company sections with collapsible role lists.
  return (
    <GroupedList
      groups={groups}
      sortBy={sortBy}
      pendingIds={pendingIds}
      onToggleApplied={onToggleApplied}
      onHide={onHide}
      isOwner={isOwner}
    />
  );
}

export const InternshipList = memo(InternshipListImpl);

function GroupedList({
  groups,
  sortBy,
  pendingIds,
  onToggleApplied,
  onHide,
  isOwner,
}: Omit<Props, "items"> & { groups: Group[] }): React.JSX.Element {
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
              {g.appliedCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/12 text-emerald-300 border border-emerald-500/25 tabular-nums">
                  {g.appliedCount} applied
                </span>
              )}
            </button>
            {open && (
              <div className="flex flex-col gap-0.5 px-1 pb-1.5">
                {g.items.map((item) => (
                  <InternshipRow
                    key={item.id}
                    item={item}
                    pending={pendingIds.has(item.id)}
                    onToggleApplied={onToggleApplied}
                    onHide={onHide}
                    isOwner={isOwner}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
