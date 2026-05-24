/**
 * One-shot migration: SQLite (./data/internships.db or a custom path via --src)
 * → Postgres (DATABASE_URL).
 *
 * Usage:
 *   npx tsx scripts/migrate-sqlite-to-postgres.ts                # local SQLite → DATABASE_URL
 *   npx tsx scripts/migrate-sqlite-to-postgres.ts --src=/tmp/prod-snapshot.db
 *   npx tsx scripts/migrate-sqlite-to-postgres.ts --force        # required to truncate non-empty target
 *
 * Safety:
 *   - Refuses to TRUNCATE a Postgres that already has rows unless --force is given.
 *   - Wraps the whole copy in a transaction; failure rolls back cleanly.
 *
 * Coercion notes:
 *   - SQLite TEXT (ISO8601) → TIMESTAMPTZ: pg accepts ISO strings directly.
 *   - SQLite INTEGER 0/1   → BOOLEAN:      coerced with `!!r.col`.
 *   - SQLite TEXT (JSON)   → JSONB:        validated/repaired via safeJson() —
 *                                          empty string and invalid JSON fall
 *                                          back to '[]' or NULL so a single bad
 *                                          row can't abort the migration.
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { Pool } from 'pg';

dotenv.config();

const args = process.argv.slice(2);
const srcArg = args.find((a) => a.startsWith('--src='));
const SRC_DB = srcArg ? srcArg.slice('--src='.length) : path.join(process.cwd(), 'data', 'internships.db');
const FORCE = args.includes('--force');
const BATCH = 500;

const COLS = [
  'id','title','company','location','description','link','source',
  'ats_source','ats_job_id','ats_target','posted_at','seen_at',
  'score','score_label','matched_keywords','is_new','applied',
  'archived','applied_at','application_url','application_status',
  'failed_check_count','first_failed_at','last_checked_at',
  'multi_location','salary_text','salary_min','salary_max','salary_unit',
  'normalized_key','hidden','season',
] as const;

interface SqliteRow {
  id: string; title: string; company: string; location: string;
  description: string | null; link: string; source: string;
  ats_source: string | null; ats_job_id: string | null; ats_target: string | null;
  posted_at: string; seen_at: string;
  score: number | null; score_label: string | null;
  matched_keywords: string;
  is_new: number; applied: number; archived: number;
  applied_at: string | null; application_url: string | null; application_status: string | null;
  failed_check_count: number; first_failed_at: string | null; last_checked_at: string | null;
  multi_location: string | null;
  salary_text: string | null; salary_min: number | null; salary_max: number | null;
  salary_unit: string | null;
  normalized_key: string | null; hidden: number; season: string | null;
}

function safeJson(raw: string | null, fallback: string | null, field: string, rowId: string): string | null {
  if (raw == null || raw === '') return fallback;
  try {
    JSON.parse(raw);
    return raw;
  } catch (e: any) {
    console.warn(`[migrate] row ${rowId} ${field} invalid JSON (${e.message}) — using ${fallback === null ? 'NULL' : fallback}`);
    return fallback;
  }
}

// Postgres TIMESTAMPTZ accepts ISO8601 and 'YYYY-MM-DD' natively. A handful of
// rows from YC WaaS carry relative strings like "1 day ago" / "5 months ago"
// that pg can't parse — fall back to seen_at (a real timestamp, upper-bounds
// posted_at) so the migration doesn't abort on three rows.
function coerceTimestamp(raw: string, fallback: string, rowId: string, field: string): string {
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(raw)) return raw;
  console.warn(`[migrate] row ${rowId} ${field} = ${JSON.stringify(raw)} unparseable — falling back to ${fallback}`);
  return fallback;
}

function rowToValues(r: SqliteRow): unknown[] {
  return [
    r.id, r.title, r.company, r.location, r.description, r.link, r.source,
    r.ats_source, r.ats_job_id, r.ats_target,
    coerceTimestamp(r.posted_at, r.seen_at, r.id, 'posted_at'),
    r.seen_at,
    r.score, r.score_label,
    safeJson(r.matched_keywords, '[]', 'matched_keywords', r.id),
    !!r.is_new, !!r.applied, !!r.archived,
    r.applied_at, r.application_url, r.application_status,
    r.failed_check_count, r.first_failed_at, r.last_checked_at,
    safeJson(r.multi_location, null, 'multi_location', r.id),
    r.salary_text, r.salary_min, r.salary_max, r.salary_unit,
    r.normalized_key, !!r.hidden,
    safeJson(r.season, null, 'season', r.id),
  ];
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set');
  }
  console.log(`[migrate] src = ${SRC_DB}`);
  console.log(`[migrate] dst = ${process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);

  const sqlite = new Database(SRC_DB, { readonly: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    // Safety: only truncate if target is empty, or --force was given.
    const existing = await client.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM internships');
    const existingCount = Number(existing.rows[0].c);
    if (existingCount > 0 && !FORCE) {
      console.error(`[migrate] ABORT: target Postgres has ${existingCount} rows. Pass --force to truncate and replace.`);
      process.exit(2);
    }

    const internships = sqlite.prepare('SELECT * FROM internships').all() as SqliteRow[];
    const seenIds = sqlite.prepare('SELECT id FROM seen_ids').all() as { id: string }[];
    console.log(`[migrate] reading ${internships.length} internships, ${seenIds.length} seen_ids`);

    await client.query('BEGIN');
    await client.query('TRUNCATE internships, seen_ids');

    // Batched VALUES insert. 32 cols × 500 rows = 16,000 placeholders, well under pg's 32k limit.
    for (let offset = 0; offset < internships.length; offset += BATCH) {
      const chunk = internships.slice(offset, offset + BATCH);
      const values: unknown[] = [];
      const tuples: string[] = [];
      let p = 1;
      for (const row of chunk) {
        const vs = rowToValues(row);
        values.push(...vs);
        tuples.push(`(${vs.map(() => `$${p++}`).join(',')})`);
      }
      const sql = `INSERT INTO internships (${COLS.join(',')}) VALUES ${tuples.join(',')}`;
      await client.query(sql, values);
      if ((offset + chunk.length) % 2000 === 0 || offset + chunk.length === internships.length) {
        console.log(`[migrate]   internships ${offset + chunk.length}/${internships.length}`);
      }
    }

    // seen_ids — single bulk insert.
    if (seenIds.length > 0) {
      for (let offset = 0; offset < seenIds.length; offset += 1000) {
        const chunk = seenIds.slice(offset, offset + 1000);
        const placeholders = chunk.map((_, i) => `($${i + 1})`).join(',');
        await client.query(
          `INSERT INTO seen_ids (id) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
          chunk.map((s) => s.id),
        );
      }
      console.log(`[migrate]   seen_ids ${seenIds.length}/${seenIds.length}`);
    }

    await client.query('COMMIT');

    const final = await client.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM internships');
    console.log(`[migrate] DONE: internships=${final.rows[0].c} seen_ids=${seenIds.length}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch((e) => {
  console.error('[migrate] FAILED:', e);
  process.exit(1);
});
