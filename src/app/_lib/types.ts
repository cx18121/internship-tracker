export interface Internship {
  id: string;
  title: string;
  company: string;
  location: string;
  link: string;
  source: string;
  postedAt: string;
  seenAt: string;
  score: number | null;
  scoreLabel: string;
  matchedKeywords?: string[];
  isNew: boolean;
  applied: boolean;
  hidden?: boolean;
  description?: string;
  salaryText?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryUnit?: 'hourly' | 'monthly' | 'yearly';
  season?: string[];
}

export interface Stats {
  total: number;
  bySource: Record<string, number>;
  byLabel: Record<string, number>;
  lastPolledAt: string | null;
  exclusionCounts: Record<string, number>;
}

export interface Sources {
  total: number;
  byType: Record<string, number>;
}

export type AppliedFilter = "all" | "applied" | "not-applied";
export type SortBy = "score" | "posted";
export type TierFilter = "all" | "solid-or-better" | "top-or-better" | "elite";
export type DateWindow = "all" | "1d" | "3d" | "7d" | "30d" | "90d";
