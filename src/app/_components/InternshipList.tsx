"use client";

// Orchestrates the spreadsheet list view: column headers + flat rows, OR
// collapsible per-company sections when groupByCompany is on. Both modes
// reuse the same InternshipRow for visual consistency.

import { useState, useMemo } from "react";
import { ChevronRight } from "lucide-react";
import type { Internship } from "../_lib/types";
import { InternshipRow, LIST_GRID_COLS } from "./InternshipRow";

const COL_HEADERS = ["Score", "Company", "Title", "Location", "Season", "Posted", ""];

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
      className={`grid ${LIST_GRID_COLS} items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-white/30 font-medium`}
    >
      {COL_HEADERS.map((label, i) => (
        <span key={i} className={i === COL_HEADERS.length - 1 ? "justify-self-end" : ""}>
          {label}
        </span>
      ))}
    </div>
  );
}

export function InternshipList({ items, groupByCompany, onToggleApplied }: Props) {
  if (!groupByCompany) {
    return (
      <div className="flex flex-col gap-1">
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
          <div key={g.company} className="rounded border border-white/[0.06] bg-white/[0.02]">
            <button
              onClick={() => toggle(g.company)}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/[0.04] transition-colors text-left"
            >
              <ChevronRight
                className={`h-3.5 w-3.5 text-white/40 transition-transform ${open ? "rotate-90" : ""}`}
              />
              <span className="font-semibold text-white">{g.company}</span>
              <span className="text-[11px] text-white/40">
                {g.items.length} role{g.items.length !== 1 ? "s" : ""}
              </span>
              <span className="text-[11px] text-white/30">avg {g.avgScore}</span>
              {g.appliedCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {g.appliedCount} applied
                </span>
              )}
            </button>
            {open && (
              <div className="flex flex-col gap-1 px-1 pb-1">
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
