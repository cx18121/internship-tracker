import type { TierFilter, DegreeFilter } from './filter-spec';
import { DEGREES, ROLE_TYPES, type RoleType } from './classify/posting';

/** Gates a new posting must pass before it is pushed to Discord. Browser-safe
 *  (no I/O); load/save live in app-state.ts. */
export interface NotifSettings {
  minScore: number;
  sourceDownAlerts: boolean;
  tierFilter: TierFilter;
  /** Season tokens like "summer-2027". Empty means no season gate. */
  seasons: string[];
  /** Source names as written to Internship.source. Empty means all sources. */
  excludedSources: string[];
  /** Postings classified 'unknown' still notify. */
  excludeNonUS: boolean;
  /** Classified role types to notify on. Empty means all. */
  roleTypes: RoleType[];
  /** Eligible degree levels to notify on; 'unknown' covers postings with no signal. Empty means all. */
  degrees: DegreeFilter[];
}

export const DEFAULT_NOTIF_SETTINGS: NotifSettings = {
  minScore: 50,
  sourceDownAlerts: false,
  tierFilter: 'all',
  seasons: [],
  excludedSources: [],
  excludeNonUS: false,
  roleTypes: [],
  degrees: [],
};

/**
 * Parse untrusted input (a JSON body, or a stored value from an older
 * schema) into a valid NotifSettings. Missing or invalid fields keep the
 * baseline value. Never throws.
 */
export function parseNotifSettings(input: unknown, baseline: NotifSettings = DEFAULT_NOTIF_SETTINGS): NotifSettings {
  const b: Record<string, unknown> = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const bool = (k: 'sourceDownAlerts' | 'excludeNonUS') => (typeof b[k] === 'boolean' ? (b[k] as boolean) : baseline[k]);
  const list = <T extends string>(k: keyof NotifSettings, keep: (x: string) => x is T): T[] =>
    k in b ? stringList(b[k]).filter(keep) : (baseline[k] as T[]);
  return {
    minScore: typeof b.minScore === 'number' && Number.isFinite(b.minScore)
      ? Math.max(0, Math.min(100, Math.round(b.minScore)))
      : baseline.minScore,
    sourceDownAlerts: bool('sourceDownAlerts'),
    tierFilter: isTierFilter(b.tierFilter) ? b.tierFilter : baseline.tierFilter,
    seasons: list('seasons', (x): x is string => /^(summer|fall|winter|spring)-\d{4}$/.test(x.toLowerCase())).map(x => x.toLowerCase()),
    excludedSources: list('excludedSources', (x): x is string => true),
    excludeNonUS: bool('excludeNonUS'),
    roleTypes: list('roleTypes', (x): x is RoleType => (ROLE_TYPES as readonly string[]).includes(x)),
    degrees: list('degrees', (x): x is DegreeFilter => x === 'unknown' || (DEGREES as readonly string[]).includes(x)),
  };
}

function isTierFilter(t: unknown): t is TierFilter {
  return t === 'all' || t === 'elite' || t === 'top-or-better' || t === 'solid-or-better';
}

function stringList(s: unknown): string[] {
  if (!Array.isArray(s)) return [];
  const out = new Set<string>();
  for (const x of s) if (typeof x === 'string' && x.trim()) out.add(x.trim());
  return [...out].slice(0, 32);
}
