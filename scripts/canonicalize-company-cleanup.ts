/**
 * One-shot cleanup: canonicalize company names on existing rows and collapse
 * the cross-source duplicates that the raw-company dedup key let through
 * (e.g. "NVIDIA" + "NVIDIA AI" → "NVIDIA", "Adobe Systems" → "Adobe").
 *
 * Usage:
 *   npx tsx scripts/canonicalize-company-cleanup.ts            # dry-run (default)
 *   npx tsx scripts/canonicalize-company-cleanup.ts --apply    # write to DB
 *
 * Targets whatever DATABASE_URL points to — local .env reads the shared
 * Railway Postgres, so --apply updates production. Always dry-run first.
 *
 * What it does to ACTIVE (archived=false) rows:
 *   1. company        → canonicalizeCompany(stripEmojiPrefix(company))
 *      normalized_key → normalizeKey(canonCompany, title)
 *      (also strips stale "🔥 "-prefixed keys left by older ingestion.)
 *   2. Rows that now share a normalized_key (with a non-empty normalized
 *      title) are a cross-source duplicate set: keep one survivor (the row the
 *      user interacted with / highest score / freshest), merge user state
 *      (applied / applied_at / application_url / application_status / hidden)
 *      into it, and DELETE the rest.
 *
 * IMPORTANT — run AFTER deploying the canonicalizing ingestion code (enrich.ts).
 * The live poller must already canonicalize company names, otherwise the next
 * poll re-inserts the raw-named variants ("NVIDIA AI") this cleanup just
 * collapsed.
 *
 * Why DELETE, not archive: the dedup refresh path matches by exact id WITHOUT
 * filtering archived, and un-archives on rediscovery — so an archived duplicate
 * whose posting is still live would resurrect on the next poll. A deleted
 * loser, by contrast, is re-absorbed into the survivor via normalized_key.
 * The pre-write JSON backup in data/backups/ is the recovery net.
 *
 * Deliberately does NOT rewrite the primary-key `id`. The id encodes the
 * original (company,title,link) and many rows already carry an id that the
 * current pipeline wouldn't recompute identically — yet matching on polls uses
 * the LIVE upstream link, so it works regardless. A company-changed row whose
 * id is now stale simply stops being exact-matched, ages out via the normal
 * 30-day stale sweep, and is re-added cleanly under its canonical name — while
 * the user sees the corrected company immediately. Rewriting ids would risk PK
 * collisions and break any client state keyed by id, for no reliable gain.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { getPool, closePool } from '../src/lib/db';
import { canonicalizeCompany } from '../src/lib/canonicalize-company';
import { normalizeKey } from '../src/lib/normalize-key';
import { stripEmojiPrefix } from '../src/lib/utils/normalize';

const APPLY = process.argv.includes('--apply');

interface Row {
  id: string;
  title: string;
  company: string;
  link: string;
  source: string;
  score: number | null;
  seen_at: Date;
  applied: boolean;
  hidden: boolean;
  applied_at: Date | null;
  application_url: string | null;
  application_status: string | null;
  normalized_key: string | null;
}

interface SurvivorUpdate {
  id: string;
  company: string;
  normalizedKey: string;
  applied: boolean;
  appliedAt: Date | null;
  applicationUrl: string | null;
  applicationStatus: string | null;
  hidden: boolean;
}

interface Plan {
  survivorUpdates: SurvivorUpdate[];
  losersToDelete: string[];
}

// Pick the survivor of a duplicate group. Earlier criteria dominate.
function pickSurvivor(group: Row[]): Row {
  const hasState = (r: Row) => r.applied || r.hidden || !!r.application_url;
  return [...group].sort((a, b) => {
    if (hasState(a) !== hasState(b)) return hasState(a) ? -1 : 1;
    if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
    if (b.seen_at.getTime() !== a.seen_at.getTime()) return b.seen_at.getTime() - a.seen_at.getTime();
    return a.id < b.id ? -1 : 1;
  })[0];
}

async function main(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<Row>(`
    SELECT id, title, company, link, source, score, seen_at,
           applied, hidden, applied_at, application_url, application_status,
           normalized_key
    FROM internships
    WHERE archived = false
  `);
  console.log(`[cleanup] Loaded ${rows.length} active rows`);

  // Compute canonical values and group by the canonical normalized_key.
  const groups = new Map<string, Row[]>();
  const canonOf = new Map<string, { company: string; key: string }>();
  let companyChanged = 0;
  for (const r of rows) {
    const company = canonicalizeCompany(stripEmojiPrefix(r.company || ''));
    const key = normalizeKey(company, r.title || '');
    canonOf.set(r.id, { company, key });
    if (company !== r.company) companyChanged++;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const plan: Plan = { survivorUpdates: [], losersToDelete: [] };
  const dupGroupSamples: string[] = [];
  let crossSourceMerges = 0;

  function pushUpdateIfChanged(r: Row, mergedState?: Partial<SurvivorUpdate>): void {
    const c = canonOf.get(r.id)!;
    const u: SurvivorUpdate = {
      id: r.id, company: c.company, normalizedKey: c.key,
      applied: mergedState?.applied ?? r.applied,
      appliedAt: mergedState?.appliedAt ?? r.applied_at,
      applicationUrl: mergedState?.applicationUrl ?? r.application_url,
      applicationStatus: mergedState?.applicationStatus ?? r.application_status,
      hidden: mergedState?.hidden ?? r.hidden,
    };
    const changed = u.company !== r.company
      || u.normalizedKey !== (r.normalized_key ?? '')
      || u.applied !== r.applied
      || u.hidden !== r.hidden
      || (u.appliedAt?.getTime() ?? null) !== (r.applied_at?.getTime() ?? null)
      || u.applicationUrl !== r.application_url
      || u.applicationStatus !== r.application_status;
    if (changed) plan.survivorUpdates.push(u);
  }

  for (const [key, group] of groups.entries()) {
    const cleanedTitle = key.split('::').slice(1).join('::').trim();

    // Cross-source merge ONLY when the title carries real signal. A title that
    // normalizes to empty ("Intern", "Summer 2026 Internship") would otherwise
    // falsely collapse genuinely-distinct roles at the same company. (No two
    // rows can share an exact (company,title,link) — that's the id PK — so all
    // group members are distinct postings.)
    if (group.length > 1 && cleanedTitle) {
      const survivor = pickSurvivor(group);
      const mergedApplied = group.some(r => r.applied);
      const appliedAts = group.filter(r => r.applied && r.applied_at).map(r => r.applied_at!.getTime());
      const mergedAppliedAt = appliedAts.length ? new Date(Math.min(...appliedAts)) : survivor.applied_at;
      const appliedRow = group.find(r => r.applied && r.application_url) ?? group.find(r => r.application_url);
      const mergedHidden = group.some(r => r.hidden) && !mergedApplied;

      pushUpdateIfChanged(survivor, {
        applied: mergedApplied, appliedAt: mergedAppliedAt,
        applicationUrl: appliedRow?.application_url ?? null,
        applicationStatus: appliedRow?.application_status ?? null,
        hidden: mergedHidden,
      });
      for (const r of group) {
        if (r.id === survivor.id) continue;
        plan.losersToDelete.push(r.id);
      }
      crossSourceMerges++;
      if (dupGroupSamples.length < 12) {
        const names = [...new Set(group.map(r => r.company))].join(' | ');
        dupGroupSamples.push(`  ${group.length}× [${canonOf.get(survivor.id)!.company}] "${survivor.title.slice(0, 50)}"  (raw: ${names})`);
      }
      continue;
    }

    // Lone row or distinct-role group: just canonicalize company/key in place.
    for (const r of group) pushUpdateIfChanged(r);
  }

  // ---- Report ----
  console.log(`\n=== Plan (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  const deleteSet = new Set(plan.losersToDelete);
  console.log(`  rows with company name change : ${companyChanged}`);
  console.log(`  cross-source duplicate groups  : ${crossSourceMerges}`);
  console.log(`  rows to DELETE (dup losers)    : ${plan.losersToDelete.length}`);
  console.log(`  rows to update in place        : ${plan.survivorUpdates.length}`);
  console.log(`\n  sample duplicate groups:`);
  console.log(dupGroupSamples.join('\n'));

  const nvidia = rows.filter(r => /nvidia/i.test(r.company));
  const nvidiaDeleted = nvidia.filter(r => deleteSet.has(r.id));
  console.log(`\n  NVIDIA-ish active rows BEFORE: ${nvidia.length} across {${[...new Set(nvidia.map(r => r.company))].join(', ')}}`);
  console.log(`  NVIDIA AFTER: ${nvidia.length - nvidiaDeleted.length} kept, ${nvidiaDeleted.length} deleted → canonical "NVIDIA"`);

  if (!APPLY) {
    console.log(`\n[dry-run] No DB writes. Re-run with --apply to commit.`);
    return;
  }

  // ---- Backup ----
  const backupDir = path.join(process.cwd(), 'data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const affectedIds = new Set<string>([
    ...plan.survivorUpdates.map(u => u.id),
    ...plan.losersToDelete,
  ]);
  const backup = rows.filter(r => affectedIds.has(r.id));
  const backupPath = path.join(backupDir, `canonicalize-cleanup-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\n[backup] Wrote ${backup.length} affected rows → ${backupPath}`);

  // ---- Write ----
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (plan.losersToDelete.length) {
      await client.query(`DELETE FROM internships WHERE id = ANY($1::text[])`, [plan.losersToDelete]);
    }
    for (const u of plan.survivorUpdates) {
      await client.query(
        `UPDATE internships
           SET company = $2, normalized_key = $3, applied = $4, applied_at = $5,
               application_url = $6, application_status = $7, hidden = $8
         WHERE id = $1`,
        [u.id, u.company, u.normalizedKey, u.applied, u.appliedAt,
         u.applicationUrl, u.applicationStatus, u.hidden],
      );
    }
    await client.query('COMMIT');
    console.log(`[cleanup] Committed: deleted ${plan.losersToDelete.length}, updated ${plan.survivorUpdates.length}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[cleanup] ROLLED BACK due to error:', e);
    throw e;
  } finally {
    client.release();
  }
}

main()
  .catch(err => { console.error('[cleanup] failed:', err); process.exitCode = 1; })
  .finally(async () => { await closePool(); });
