import { ROLE_SPECIALIZATIONS, isRoleId, type RoleId } from './role-taxonomy';
import type { TierFilter } from './filter-spec';

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
  /** Matched against the scorer's matchedKeywords, not free text. */
  includeKeywords: string[];
  excludeKeywords: string[];
  /** Empty means no role gate. */
  roles: RoleId[];
  skipApplied: boolean;
  skipHidden: boolean;
}

export const DEFAULT_NOTIF_SETTINGS: NotifSettings = {
  minScore: 50,
  sourceDownAlerts: false,
  tierFilter: 'all',
  seasons: [],
  excludedSources: [],
  excludeNonUS: false,
  includeKeywords: [],
  excludeKeywords: [],
  roles: [],
  skipApplied: true,
  skipHidden: true,
};

/**
 * Parse untrusted input (a JSON body, or a stored value from an older
 * schema) into a valid NotifSettings. Missing or invalid fields keep the
 * baseline value. Never throws.
 */
export function parseNotifSettings(input: unknown, baseline: NotifSettings = DEFAULT_NOTIF_SETTINGS): NotifSettings {
  const b: Record<string, unknown> = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const bool = (k: keyof NotifSettings) => (typeof b[k] === 'boolean' ? (b[k] as boolean) : (baseline[k] as boolean));
  const list = (k: keyof NotifSettings) => (k in b ? stringList(b[k]) : (baseline[k] as string[]));
  return {
    minScore: typeof b.minScore === 'number' && Number.isFinite(b.minScore)
      ? Math.max(0, Math.min(100, Math.round(b.minScore)))
      : baseline.minScore,
    sourceDownAlerts: bool('sourceDownAlerts'),
    tierFilter: isTierFilter(b.tierFilter) ? b.tierFilter : baseline.tierFilter,
    seasons: list('seasons').map(x => x.toLowerCase()).filter(x => /^(summer|fall|winter|spring|year)-\d{4}$/.test(x)),
    excludedSources: list('excludedSources'),
    excludeNonUS: bool('excludeNonUS'),
    includeKeywords: list('includeKeywords'),
    excludeKeywords: list('excludeKeywords'),
    roles: 'roles' in b ? roleList(b.roles) : baseline.roles,
    skipApplied: bool('skipApplied'),
    skipHidden: bool('skipHidden'),
  };
}

function isTierFilter(t: unknown): t is TierFilter {
  return t === 'all' || t === 'elite' || t === 'top-or-better' || t === 'solid-or-better';
}

function roleList(s: unknown): RoleId[] {
  if (!Array.isArray(s)) return [];
  const out = new Set<RoleId>();
  for (const x of s) if (typeof x === 'string' && isRoleId(x)) out.add(x);
  return [...out].slice(0, ROLE_SPECIALIZATIONS.length);
}

function stringList(s: unknown): string[] {
  if (!Array.isArray(s)) return [];
  const out = new Set<string>();
  for (const x of s) if (typeof x === 'string' && x.trim()) out.add(x.trim());
  return [...out].slice(0, 32);
}
