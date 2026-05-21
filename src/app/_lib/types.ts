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

export interface SourceHealthEntry {
  name: string;
  total: number;
  last24h: number;
  last7d: number;
}

export type AppliedFilter = "all" | "applied" | "not-applied";
export type SortBy = "score" | "newest" | "posted";
export type TierFilter = "all" | "top-or-better" | "elite";
