import * as fs from 'fs';
import * as path from 'path';

export type TierFilter = 'all' | 'top-or-better' | 'elite';

export interface NotifSettings {
  minScore: number;
  sourceDownAlerts: boolean;
  tierFilter: TierFilter;
  seasons: string[];
}

const DEFAULT: NotifSettings = {
  minScore: 50,
  sourceDownAlerts: false,
  tierFilter: 'all',
  seasons: [],
};

// Single source of truth for the user-managed notification preferences,
// read by the poller agent (for score threshold) and the notifier (for
// tier + season gates). The settings API route (src/app/api/internships/
// settings/route.ts) writes the same file shape.
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
