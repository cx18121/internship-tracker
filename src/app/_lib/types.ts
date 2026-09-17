export type { ListItem as Internship } from "./list-item";
export type { TierFilter } from "@/lib/filter-spec";

export interface Stats {
  total: number;
  bySource: Record<string, number>;
  byLabel: Record<string, number>;
  lastPolledAt: string | null;
}

export interface Sources {
  total: number;
  byType: Record<string, number>;
}

export type SortBy = "score" | "posted";
export type DateWindow = "all" | "1d" | "3d" | "7d" | "30d" | "90d";
