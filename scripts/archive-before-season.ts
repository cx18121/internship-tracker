#!/usr/bin/env npx tsx
/**
 * archive-before-season.ts
 *
 * Archives postings whose ALL season tokens fall before the given cutoff
 * (default summer-2026). Rows that match a season at-or-after the cutoff —
 * including dual-tagged rows like ["fall-2025","summer-2026"] — stay active.
 *
 * Manual archival; the auto-archive-by-age path was removed in 6790170.
 *
 * Usage:
 *   npx tsx scripts/archive-before-season.ts                    # cutoff=summer-2026
 *   npx tsx scripts/archive-before-season.ts fall-2026 --dry    # alt cutoff + report only
 */
import * as path from 'path';
import Database from 'better-sqlite3';
import { seasonSortKey } from '../src/lib/seasons';

const DB_PATH = path.join(process.cwd(), 'data', 'internships.db');
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const cutoffToken = args[0] || 'summer-2026';
const cutoffKey = seasonSortKey(cutoffToken);

function isBefore(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  return tokens.every((t) => seasonSortKey(t) < cutoffKey);
}

function main() {
  const db = new Database(DB_PATH);
  const rows = db.prepare(
    'SELECT id, season FROM internships WHERE archived = 0'
  ).all() as { id: string; season: string | null }[];

  const targets: string[] = [];
  const samples: { id: string; season: string }[] = [];
  for (const r of rows) {
    if (!r.season) continue;
    let tokens: string[];
    try { tokens = JSON.parse(r.season); } catch { continue; }
    if (!Array.isArray(tokens)) continue;
    if (!isBefore(tokens)) continue;
    targets.push(r.id);
    if (samples.length < 8) samples.push({ id: r.id, season: tokens.join(',') });
  }

  console.log(`cutoff: anything strictly before ${cutoffToken} (key=${cutoffKey})`);
  console.log(`active rows scanned: ${rows.length}`);
  console.log(`will archive: ${targets.length}`);
  if (samples.length) {
    console.log('samples:');
    for (const s of samples) console.log(`  [${s.season}] id=${s.id}`);
  }

  if (!DRY && targets.length > 0) {
    const stmt = db.prepare('UPDATE internships SET archived = 1 WHERE id = ?');
    const txn = db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(id);
    });
    txn(targets);
    console.log(`applied: ${targets.length} archived`);
  } else if (DRY) {
    console.log('(dry run — no changes written)');
  }

  db.close();
}

main();
