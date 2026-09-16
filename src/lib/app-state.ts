import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPool } from './db';
import { DEFAULT_NOTIF_SETTINGS, parseNotifSettings, type NotifSettings } from './notifSettings';

/**
 * Small shared state that both the poller and the web app read and write:
 * notification settings, last poll stats, source-fetch history, and
 * source-down alert state. One row per key in the `app_state` table.
 *
 * On first read of a key that has no row yet, a legacy `data/<key>.json`
 * sidecar is imported if present, so an existing deployment keeps its
 * settings across the move to Postgres.
 */
export async function getState<T extends object>(key: string, defaults: T): Promise<T> {
  const { rows } = await getPool().query<{ value: T }>('SELECT value FROM app_state WHERE key = $1', [key]);
  if (rows.length > 0) return { ...defaults, ...rows[0].value };

  const legacy = readLegacySidecar<T>(key);
  if (legacy) {
    await setState(key, { ...defaults, ...legacy });
    return { ...defaults, ...legacy };
  }
  return { ...defaults };
}

export async function setState<T extends object>(key: string, value: T): Promise<void> {
  await getPool().query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

function readLegacySidecar<T>(key: string): T | null {
  const file = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'), `${key}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export async function loadNotifSettings(): Promise<NotifSettings> {
  return parseNotifSettings(await getState('notif-settings', DEFAULT_NOTIF_SETTINGS));
}

export async function saveNotifSettings(s: NotifSettings): Promise<void> {
  await setState('notif-settings', s);
}
