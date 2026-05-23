import * as fs from 'fs';
import * as path from 'path';
import { ROLE_SPECIALIZATIONS, isRoleId, type RoleId } from './role-taxonomy';

export type TierFilter = 'all' | 'solid-or-better' | 'top-or-better' | 'elite';

export interface NotifChannels {
  discord: boolean;
  email: boolean;
  sms: boolean;
}

export interface NotifSettings {
  // Score gate — postings below this don't notify.
  minScore: number;
  // Toggle for the source-down detector (see checkAndAlertSourceHealth).
  sourceDownAlerts: boolean;
  // Tier gate (Elite / Top+ company filter — matches app FilterRail).
  tierFilter: TierFilter;
  // Season tokens like "summer-2026" — empty array means "no season gate".
  seasons: string[];
  // Source blocklist — empty array means notify on all sources. Names match
  // the values written to Internship.source (e.g. "SimplifyJobs", "Indeed").
  excludedSources: string[];
  // Suppress non-US postings using src/poller/iso-locations.ts classifier.
  // Postings classified as 'unknown' still notify (safe default).
  excludeNonUS: boolean;
  // Keyword gates — match against the scorer's matchedKeywords tag set
  // (NOT free-text search), same semantics as the app's FilterRail chips.
  includeKeywords: string[];
  excludeKeywords: string[];
  // Role specialization gate — OR-semantics across selected RoleIds, matched
  // against the scorer's matchedKeywords via postingMatchesAnyRole. Empty
  // array means "no role gate". See src/lib/role-taxonomy.ts.
  roles: RoleId[];
  // Skip postings the user has already engaged with in the UI. Default true
  // for both because re-surfacing an applied/hidden role is rarely useful.
  skipApplied: boolean;
  skipHidden: boolean;
  // Delivery channels. Discord uses env vars (bot token + channel id).
  // email uses RESEND_API_KEY + emailRecipients. sms uses Twilio + phoneNumbers.
  channels: NotifChannels;
  emailRecipients: string[];
  phoneNumbers: string[];
}

const DEFAULT: NotifSettings = {
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
  channels: { discord: true, email: false, sms: false },
  emailRecipients: [],
  phoneNumbers: [],
};

const SETTINGS_PATH = path.join(process.cwd(), 'data', 'notif-settings.json');

// Single source of truth for the user-managed notification preferences,
// read by the poller agent (for score threshold) and the notifier (for tier
// + season + role gates). The settings API route writes via saveNotifSettings
// and reads round-trip through this same loader, so the schema lives in one
// place.
export function loadNotifSettings(): NotifSettings {
  try {
    return { ...DEFAULT, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveNotifSettings(s: NotifSettings): NotifSettings {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
  return s;
}

// Parse arbitrary input (typically a JSON body posted from the client) into
// a valid NotifSettings. Fields missing from `input` retain their `baseline`
// value — that's the partial-update semantics the settings API route relies
// on. Garbage values are rejected per-field, falling back to baseline; the
// function never throws.
export function parseNotifSettings(
  input: unknown,
  baseline: NotifSettings = DEFAULT,
): NotifSettings {
  const body: Record<string, unknown> =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  return {
    // Number.isFinite — typeof NaN === "number" is true, so a NaN from the
    // client would slip past the typeof check and Math.round would propagate
    // NaN into the saved JSON as `null`.
    minScore:
      typeof body.minScore === 'number' && Number.isFinite(body.minScore)
        ? Math.max(0, Math.min(100, Math.round(body.minScore)))
        : baseline.minScore,
    sourceDownAlerts:
      typeof body.sourceDownAlerts === 'boolean' ? body.sourceDownAlerts : baseline.sourceDownAlerts,
    tierFilter: 'tierFilter' in body ? sanitizeTier(body.tierFilter) : baseline.tierFilter,
    seasons: 'seasons' in body ? sanitizeSeasons(body.seasons) : baseline.seasons,
    excludedSources:
      'excludedSources' in body ? sanitizeStringList(body.excludedSources) : baseline.excludedSources,
    excludeNonUS:
      typeof body.excludeNonUS === 'boolean' ? body.excludeNonUS : baseline.excludeNonUS,
    includeKeywords:
      'includeKeywords' in body ? sanitizeStringList(body.includeKeywords) : baseline.includeKeywords,
    excludeKeywords:
      'excludeKeywords' in body ? sanitizeStringList(body.excludeKeywords) : baseline.excludeKeywords,
    roles: 'roles' in body ? sanitizeRoles(body.roles) : baseline.roles,
    skipApplied:
      typeof body.skipApplied === 'boolean' ? body.skipApplied : baseline.skipApplied,
    skipHidden:
      typeof body.skipHidden === 'boolean' ? body.skipHidden : baseline.skipHidden,
    channels: 'channels' in body ? sanitizeChannels(body.channels, baseline.channels) : baseline.channels,
    emailRecipients:
      'emailRecipients' in body ? sanitizeEmailList(body.emailRecipients) : baseline.emailRecipients,
    phoneNumbers:
      'phoneNumbers' in body ? sanitizePhoneList(body.phoneNumbers) : baseline.phoneNumbers,
  };
}

function sanitizeTier(t: unknown): TierFilter {
  return t === 'elite' || t === 'top-or-better' || t === 'solid-or-better' ? t : 'all';
}

function sanitizeSeasons(s: unknown): string[] {
  if (!Array.isArray(s)) return [];
  return s
    .filter((x): x is string => typeof x === 'string')
    .map(x => x.trim().toLowerCase())
    .filter(x => /^(summer|fall|winter|spring|year)-\d{4}$/.test(x));
}

// Filters to known RoleId values and dedupes. Cap at the number of roles in
// the taxonomy — any input larger than that is malformed, not a feature.
function sanitizeRoles(s: unknown): RoleId[] {
  if (!Array.isArray(s)) return [];
  const max = ROLE_SPECIALIZATIONS.length;
  const seen = new Set<RoleId>();
  const out: RoleId[] = [];
  for (const x of s) {
    if (typeof x !== 'string' || !isRoleId(x) || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeChannels(s: unknown, baseline: NotifChannels): NotifChannels {
  if (!s || typeof s !== 'object') return baseline;
  const c = s as Record<string, unknown>;
  return {
    discord: typeof c.discord === 'boolean' ? c.discord : baseline.discord,
    email: typeof c.email === 'boolean' ? c.email : baseline.email,
    sms: typeof c.sms === 'boolean' ? c.sms : baseline.sms,
  };
}

function sanitizeEmailList(s: unknown): string[] {
  if (!Array.isArray(s)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of s) {
    if (typeof x !== 'string') continue;
    const trimmed = x.trim().toLowerCase();
    if (!trimmed || seen.has(trimmed) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 10) break;
  }
  return out;
}

function sanitizePhoneList(s: unknown): string[] {
  if (!Array.isArray(s)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of s) {
    if (typeof x !== 'string') continue;
    const trimmed = x.trim();
    if (!trimmed || seen.has(trimmed) || !/^\+\d{10,15}$/.test(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 5) break;
  }
  return out;
}

// Generic string-array sanitizer for keyword/source lists. Trims, drops
// empties, dedupes, caps at 32 entries to keep the JSON small and prevent a
// runaway settings file from blowing up the notifier loop.
function sanitizeStringList(s: unknown): string[] {
  if (!Array.isArray(s)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of s) {
    if (typeof x !== 'string') continue;
    const trimmed = x.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 32) break;
  }
  return out;
}
