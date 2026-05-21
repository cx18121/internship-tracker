"use client";

// Orchestrates the spreadsheet list view: column headers + flat rows, OR
// collapsible per-company sections when groupByCompany is on. Both modes
// reuse the same InternshipRow for visual consistency.

import { useState, useMemo } from "react";
import { ChevronRight } from "lucide-react";
import type { Internship } from "../_lib/types";
import { InternshipRow, LIST_GRID_COLS } from "./InternshipRow";

// Headers in display order. The "hidden" entries match the columns
// InternshipRow hides at narrow widths — they stay rendered so the grid
// template lines up, but Tailwind classes collapse them visually.
const COL_HEADERS: Array<{ label: string; mobileHidden?: boolean }> = [
  { label: "Score" },
  { label: "Company" },
  { label: "Title", mobileHidden: true },
  { label: "Location", mobileHidden: true },
  { label: "Season", mobileHidden: true },
  { label: "Posted" },
  { label: "" },
];

interface Props {
  items: Internship[];
  groupByCompany: boolean;
  onToggleApplied: (id: string, current: boolean) => void;
}

interface Group {
  company: string;
  items: Internship[];
  avgScore: number;
  appliedCount: number;
}

function groupItems(items: Internship[]): Group[] {
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
  groups.sort((a, b) => b.avgScore - a.avgScore);
  return groups;
}

function ColumnHeader(): React.JSX.Element {
  return (
    <div
      className={`grid ${LIST_GRID_COLS} items-center gap-2 md:gap-3 px-2.5 md:px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-white/45 border-b border-white/[0.06]`}
    >
      {COL_HEADERS.map(({ label, mobileHidden }, i) => (
        <span
          key={i}
          className={`${mobileHidden ? "hidden md:inline" : ""} ${
            i === COL_HEADERS.length - 1 ? "justify-self-end" : ""
          }`}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export function InternshipList({ items, groupByCompany, onToggleApplied }: Props) {
  if (!groupByCompany) {
    return (
      <div className="flex flex-col gap-0.5">
        <ColumnHeader />
        {items.map((item) => (
          <InternshipRow
            key={item.id}
            item={item}
            onToggleApplied={() => onToggleApplied(item.id, item.applied)}
          />
        ))}
      </div>
    );
  }

  // Grouped mode — render company sections with collapsible role lists.
  return <GroupedList items={items} onToggleApplied={onToggleApplied} />;
}

function GroupedList({ items, onToggleApplied }: Omit<Props, "groupByCompany">): React.JSX.Element {
  const groups = useMemo(() => groupItems(items), [items]);
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
      <ColumnHeader />
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
                    onToggleApplied={() => onToggleApplied(item.id, item.applied)}
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
