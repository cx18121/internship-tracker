export const LOCATION_PRESETS = ["Remote", "NYC", "SF", "Seattle", "Boston", "Austin"];

export const PAGE_SIZE = 50;

// Time-window filter options. Days are converted to a millisecond delta at
// filter time; `all` short-circuits the check.
export const DATE_WINDOWS: { value: import("./types").DateWindow; label: string; days: number | null }[] = [
  { value: "all", label: "All time", days: null },
  { value: "1d",  label: "24h",      days: 1 },
  { value: "3d",  label: "3 days",   days: 3 },
  { value: "7d",  label: "Week",     days: 7 },
  { value: "30d", label: "Month",    days: 30 },
  { value: "90d", label: "3 months", days: 90 },
];

export const SCORE_BADGE: Record<string, string> = {
  A: "bg-green-500/20 text-green-400 border border-green-500/30",
  B: "bg-amber-500/20 text-amber-400 border border-amber-500/30",
  C: "bg-orange-500/20 text-orange-400 border border-orange-500/30",
  D: "bg-white/10 text-white/50 border border-white/15",
  F: "bg-white/[0.04] text-white/45 border border-white/10",
};

export const SCORE_BADGE_FALLBACK = "bg-white/5 text-white/40 border border-white/10";

export const SOURCE_BADGE: Record<string, string> = {
  SimplifyJobs:    "bg-blue-500/20 text-blue-400 border border-blue-500/30",
  Handshake:       "bg-purple-500/20 text-purple-400 border border-purple-500/30",
  Greenhouse:      "bg-green-500/20 text-green-400 border border-green-500/30",
  Lever:           "bg-teal-500/20 text-teal-400 border border-teal-500/30",
  Ashby:           "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30",
  Linkedin:        "bg-sky-500/20 text-sky-400 border border-sky-500/30",
  Indeed:          "bg-indigo-500/20 text-indigo-400 border border-indigo-500/30",
  Glassdoor:       "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30",
  Google:          "bg-rose-500/20 text-rose-400 border border-rose-500/30",
  Workday:         "bg-fuchsia-500/20 text-fuchsia-400 border border-fuchsia-500/30",
  SmartRecruiters: "bg-violet-500/20 text-violet-400 border border-violet-500/30",
  iCIMS:           "bg-pink-500/20 text-pink-400 border border-pink-500/30",
  Inhouse:         "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30",
};

export const SOURCE_BADGE_FALLBACK = "bg-white/5 text-white/40 border border-white/10";

// Single solid color per source — used as a tiny dot prefix in dense list view
// to indicate provenance without consuming a whole column.
export const SOURCE_DOT: Record<string, string> = {
  SimplifyJobs:    "bg-blue-400",
  Handshake:       "bg-purple-400",
  Greenhouse:      "bg-green-400",
  Lever:           "bg-teal-400",
  Ashby:           "bg-cyan-400",
  Linkedin:        "bg-sky-400",
  Indeed:          "bg-indigo-400",
  Glassdoor:       "bg-emerald-400",
  Google:          "bg-rose-400",
  Workday:         "bg-fuchsia-400",
  SmartRecruiters: "bg-violet-400",
  iCIMS:           "bg-pink-400",
  Inhouse:         "bg-yellow-400",
};

export const SOURCE_DOT_FALLBACK = "bg-white/30";
