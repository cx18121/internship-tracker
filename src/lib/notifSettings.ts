import * as fs from 'fs';
import * as path from 'path';

export type TierFilter = 'all' | 'top-or-better' | 'elite';

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
  // Skip postings the user has already engaged with in the UI. Default true
  // for both because re-surfacing an applied/hidden role is rarely useful.
  skipApplied: boolean;
  skipHidden: boolean;
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
  skipApplied: true,
  skipHidden: true,
};

// Single source of truth for the user-managed notification preferences,
// read by the poller agent (for score threshold) and the notifier (for
// tier + season + new filter gates). The settings API route (src/app/
// api/internships/settings/route.ts) writes the same file shape.
export function loadNotifSettings(): NotifSettings {
  try {
    const raw = fs.readFileSync(
      path.join(process.cwd(), 'data', 'notif-settings.json'),
      'utf-8',
    );
    return { ...DEFAULT, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT };
  }
}
