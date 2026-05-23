import { Briefcase, Clock, X } from "lucide-react";
import { LIST_GRID_COLS } from "./InternshipRow";

/** Pulsing bar used inside skeleton cells. */
function Bar({ className = "" }: { className?: string }) {
  return <span className={`inline-block h-2.5 rounded bg-white/[0.06] animate-pulse ${className}`} />;
}

// One width per column in the desktop template: Score, Company, Title,
// Salary, Location, Season, Posted, Verified. (Action column has its own renderer.)
const ROW_WIDTHS = [
  ["w-7", "w-24", "w-3/5", "w-12", "w-20", "w-12", "w-10", "w-10"],
  ["w-7", "w-20", "w-2/3", "w-14", "w-24", "w-14", "w-10", "w-10"],
  ["w-7", "w-28", "w-1/2", "w-10", "w-16", "w-12", "w-10", "w-10"],
  ["w-7", "w-24", "w-3/4", "w-12", "w-20", "w-14", "w-10", "w-10"],
  ["w-7", "w-20", "w-2/5", "w-14", "w-28", "w-12", "w-10", "w-10"],
  ["w-7", "w-32", "w-3/5", "w-12", "w-16", "w-14", "w-10", "w-10"],
  ["w-7", "w-24", "w-1/2", "w-10", "w-20", "w-12", "w-10", "w-10"],
  ["w-7", "w-28", "w-2/3", "w-14", "w-24", "w-14", "w-10", "w-10"],
];

export function ListSkeleton() {
  return (
    <div className="flex flex-col gap-0.5" aria-busy="true" aria-label="Loading internships">
      {/* Match real ColumnHeader so the loading state doesn't visually shift */}
      <div
        className={`grid ${LIST_GRID_COLS} items-center gap-2 md:gap-3 px-2.5 md:px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-white/35 border-b border-white/[0.06]`}
      >
        {[
          { label: "Score" },
          { label: "Company" },
          { label: "Title", mobileHidden: true },
          { label: "Salary", mobileHidden: true },
          { label: "Location", mobileHidden: true },
          { label: "Season", mobileHidden: true },
          { label: "Posted" },
          { label: "Verified", mobileHidden: true },
          { label: "" },
        ].map(({ label, mobileHidden }, i, arr) => (
          <span
            key={i}
            className={`${mobileHidden ? "hidden md:inline" : ""} ${i === arr.length - 1 ? "justify-self-end" : ""}`}
          >
            {label}
          </span>
        ))}
      </div>
      {ROW_WIDTHS.map((widths, i) => (
        <div
          key={i}
          className={`grid ${LIST_GRID_COLS} items-center gap-2 md:gap-3 px-2.5 md:px-3 py-2 rounded border border-white/[0.04] bg-white/[0.01]`}
        >
          {/* Score */}
          <Bar className={widths[0]} />
          {/* Company (+ title stacked on mobile) */}
          <div className="space-y-1">
            <Bar className={widths[1]} />
            <Bar className="md:hidden w-3/5" />
          </div>
          {/* Title — desktop only */}
          <Bar className={`hidden md:inline-block ${widths[2]}`} />
          {/* Salary — desktop only */}
          <Bar className={`hidden md:inline-block ${widths[3]}`} />
          {/* Location — desktop only */}
          <Bar className={`hidden md:inline-block ${widths[4]}`} />
          {/* Season — desktop only */}
          <Bar className={`hidden md:inline-block ${widths[5]}`} />
          {/* Posted */}
          <Bar className={widths[6]} />
          {/* Verified — desktop only */}
          <Bar className={`hidden md:inline-block ${widths[7]}`} />
          {/* Actions */}
          <span className="justify-self-end inline-flex gap-1">
            <Bar className="w-6 md:w-10 h-5 rounded" />
            <Bar className="w-5 h-5 rounded" />
          </span>
        </div>
      ))}
    </div>
  );
}

const CARD_LINES = Array.from({ length: 6 });

export function CardSkeleton() {
  return (
    <div
      className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3"
      aria-busy="true"
      aria-label="Loading internships"
    >
      {CARD_LINES.map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-2.5 p-3.5 rounded-lg border border-white/[0.06] bg-[oklch(0.16_0.005_260)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 space-y-2">
              <Bar className="w-2/5" />
              <Bar className="w-3/4 h-2" />
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <Bar className="w-10" />
              <Bar className="w-12 h-2" />
            </div>
          </div>
          <div className="flex gap-2">
            <Bar className="w-16 h-2" />
            <Bar className="w-12 h-2" />
            <Bar className="w-14 h-2" />
          </div>
          <div className="flex gap-1.5 pt-1">
            <Bar className="w-12 h-5 rounded-md" />
            <Bar className="w-20 h-5 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface EmptyStateProps {
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  onClearDateWindow: (() => void) | null;
  dateWindowLabel: string | null;
}

export function EmptyState({
  hasActiveFilters,
  onClearFilters,
  onClearDateWindow,
  dateWindowLabel,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center gap-3">
      <Briefcase className="h-9 w-9 text-white/25" />
      <div className="space-y-1">
        <p className="text-[14px] text-white/70 font-medium">
          {hasActiveFilters ? "Nothing matches these filters." : "No postings yet."}
        </p>
        <p className="text-[12px] text-white/45 max-w-sm">
          {hasActiveFilters
            ? "Try widening the time window, lowering the min-score, or clearing a chip you forgot."
            : "The tracker polls every 15 minutes. Postings will appear here as sources return data."}
        </p>
      </div>
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
          {onClearDateWindow && (
            <button
              onClick={onClearDateWindow}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] border border-white/15 bg-white/[0.04] text-white/70 hover:bg-white/[0.08] transition-colors"
            >
              <Clock className="h-3 w-3" />
              Widen window from {dateWindowLabel} to all time
            </button>
          )}
          <button
            onClick={onClearFilters}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] bg-white text-[oklch(0.13_0.005_260)] hover:bg-white/90 font-medium transition-colors"
          >
            <X className="h-3 w-3" />
            Clear all filters
          </button>
        </div>
      )}
    </div>
  );
}
