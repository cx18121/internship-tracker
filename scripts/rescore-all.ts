/**
 * One-shot rescore — recomputes score + score_label for every internship row
 * against the current src/lib/scorer.ts (which loads data/scoring-config.json).
 *
 * Usage:  npx tsx scripts/rescore-all.ts [--dry-run]
 *
 * Reports the before/after grade distribution so you can sanity-check the
 * shift before deciding to keep the new scores.
 *
 * Targets whatever DATABASE_URL points to — local .env reads the shared
 * Railway Postgres, so a rescore here updates production immediately. Use
 * --dry-run first when iterating on scorer config.
 */

import 'dotenv/config';
import { getPool, closePool } from '../src/lib/db';
import { scoreInternship } from '../src/lib/scorer';

const DRY_RUN = process.argv.includes('--dry-run');

interface Row {
  id: string;
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  score: number | null;
  score_label: string | null;
}

function histogram(rows: Array<{ score: number | null; label: string | null }>): {
  labels: Record<string, number>;
  bands: Record<string, number>;
  avg: number;
  max: number;
} {
  const labels: Record<string, number> = {};
  const bands: Record<string, number> = { '90-100': 0, '75-89': 0, '60-74': 0, '45-59': 0, '25-44': 0, '0-24': 0 };
  let sum = 0, max = 0, n = 0;
  for (const r of rows) {
    labels[r.label ?? '(null)'] = (labels[r.label ?? '(null)'] ?? 0) + 1;
    const s = r.score ?? 0;
    sum += s; n++; if (s > max) max = s;
    if (s >= 90) bands['90-100']++;
    else if (s >= 75) bands['75-89']++;
    else if (s >= 60) bands['60-74']++;
    else if (s >= 45) bands['45-59']++;
    else if (s >= 25) bands['25-44']++;
    else bands['0-24']++;
  }
  return { labels, bands, avg: n ? sum / n : 0, max };
}

function format(h: ReturnType<typeof histogram>): string {
  const labelOrder = ['A', 'B', 'C', 'D', 'F', '(null)'];
  const labelStr = labelOrder
    .filter(l => h.labels[l])
    .map(l => `${l}:${h.labels[l]}`)
    .join(' ');
  const bandStr = Object.entries(h.bands)
    .map(([b, n]) => `${b}=${n}`)
    .join(' ');
  return `  labels: ${labelStr}\n  bands : ${bandStr}\n  avg=${h.avg.toFixed(1)} max=${h.max}`;
}

async function main(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<Row>(`
    SELECT id, title, company, location, description, score, score_label
    FROM internships
  `);

  console.log(`[rescore] Loaded ${rows.length} rows from DB`);

  const before = histogram(rows.map(r => ({ score: r.score, label: r.score_label })));
  console.log(`\n=== Before ===\n${format(before)}`);

  const changedRows: Array<{ id: string; oldScore: number | null; newScore: number; oldLabel: string | null; newLabel: string }> = [];
  let unchanged = 0;

  // Collect new scores first; write inside a single transaction if not --dry-run.
  const scored = rows.map(r => {
    const result = scoreInternship({
      title: r.title ?? '',
      company: r.company ?? '',
      location: r.location ?? '',
      description: r.description ?? undefined,
    });
    const before = r.score ?? -1;
    if (result.score === before && result.scoreLabel === r.score_label) {
      unchanged++;
    } else {
      changedRows.push({
        id: r.id,
        oldScore: r.score,
        newScore: result.score,
        oldLabel: r.score_label,
        newLabel: result.scoreLabel,
      });
    }
    return { id: r.id, score: result.score, scoreLabel: result.scoreLabel, matchedKeywords: result.matchedKeywords };
  });

  if (!DRY_RUN) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of scored) {
        await client.query(
          `UPDATE internships
             SET score = $1,
                 score_label = $2,
                 matched_keywords = $3
           WHERE id = $4`,
          [s.score, s.scoreLabel, JSON.stringify(s.matchedKeywords), s.id],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  const after = histogram(
    changedRows.length === 0
      ? rows.map(r => ({ score: r.score, label: r.score_label }))
      : rows.map(r => {
          const ch = changedRows.find(c => c.id === r.id);
          return ch ? { score: ch.newScore, label: ch.newLabel } : { score: r.score, label: r.score_label };
        }),
  );

  console.log(`\n=== After ===\n${format(after)}`);
  console.log(`\nChanged: ${changedRows.length}    Unchanged: ${unchanged}`);

  if (DRY_RUN) {
    console.log(`\n[dry-run] No DB writes. Re-run without --dry-run to commit.`);
  }

  // Spot-check: show 3 random A-grade and 3 random F-grade rows from the new scoring
  const aGrade = changedRows.filter(c => c.newLabel === 'A');
  const fGrade = changedRows.filter(c => c.newLabel === 'F');
  function sample<T>(arr: T[], n: number): T[] {
    const copy = [...arr];
    const out: T[] = [];
    for (let i = 0; i < n && copy.length > 0; i++) {
      out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return out;
  }
  if (aGrade.length > 0) {
    console.log(`\nSample A-grade (post-rescore):`);
    for (const c of sample(aGrade, 5)) {
      const row = rows.find(r => r.id === c.id)!;
      console.log(`  [${c.newScore}] ${row.company} — ${row.title?.slice(0, 60)}`);
    }
  }
  if (fGrade.length > 0) {
    console.log(`\nSample F-grade (post-rescore):`);
    for (const c of sample(fGrade, 5)) {
      const row = rows.find(r => r.id === c.id)!;
      console.log(`  [${c.newScore}] ${row.company} — ${row.title?.slice(0, 60)}`);
    }
  }
}

main()
  .catch(err => { console.error('[rescore] failed:', err); process.exitCode = 1; })
  .finally(async () => { await closePool(); });
