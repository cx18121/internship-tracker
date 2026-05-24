# Postgres Migration Plan

Single-session executable plan to move the app from SQLite (local file + Railway volume) to a Postgres instance that both local dev and prod share. Eliminates the "two databases that drift" problem you've been hitting after every scorer change.

**Realistic effort:** 4–8 hours of focused work. Don't start tired. Have the dev server, Railway dashboard, and `npm test` runner ready.

---

## 1. Goal

- One Postgres database that both local dev and prod connect to via `DATABASE_URL`.
- Same code paths whether running `npm run poller` locally or in the Railway container.
- A one-off rescore script (or any future migration script) targets whatever `DATABASE_URL` points to — no more "rescored local but prod is stale."
- All existing data (~7k active rows on prod, ~10k including archived) preserved.

## 2. Pre-flight (do this first)

1. **Provision Postgres on Railway.** Dashboard → your project → "+ New" → Database → Postgres. Railway auto-creates the service and exposes `DATABASE_URL` as an env var to other services in the project.
2. **Pull the connection string.** `railway variables --service Postgres` (or copy from the dashboard). You'll get something like `postgresql://postgres:xxx@xxx.proxy.rlwy.net:PORT/railway`.
3. **Add to local `.env`** as `DATABASE_URL=...`. Keep both `DATABASE_URL` and the existing SQLite file present during migration — the code will switch on env var.
4. **Verify `pg` is installed.** It already is (`pg: ^8.21.0` in `package.json`), so `npm install pg` shouldn't be needed.
5. **Take a snapshot of prod's SQLite DB.** `railway ssh "cat /app/data/internships.db" > /tmp/prod-snapshot.db` — emergency backup before any cutover.
6. **Verify tests pass before starting.** `npm test` should be 73/79 (the 6 server-required ones need `test:full`). Don't start the migration if anything else is failing.

## 3. Schema translation

Canonical Postgres schema. Run as a single migration once Postgres is reachable:

```sql
CREATE TABLE internships (
  id                   TEXT        PRIMARY KEY,
  title                TEXT        NOT NULL,
  company              TEXT        NOT NULL,
  location             TEXT        NOT NULL,
  description          TEXT,
  link                 TEXT        NOT NULL,
  source               TEXT        NOT NULL,
  ats_source           TEXT,
  ats_job_id           TEXT,
  ats_target           TEXT,
  posted_at            TIMESTAMPTZ NOT NULL,          -- was TEXT ISO string
  seen_at              TIMESTAMPTZ NOT NULL,
  score                INTEGER,
  score_label          TEXT,
  matched_keywords     JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- was TEXT JSON
  is_new               BOOLEAN     NOT NULL DEFAULT true,         -- was INTEGER 0/1
  applied              BOOLEAN     NOT NULL DEFAULT false,
  archived             BOOLEAN     NOT NULL DEFAULT false,
  applied_at           TIMESTAMPTZ,
  application_url      TEXT,
  application_status   TEXT,
  failed_check_count   INTEGER     NOT NULL DEFAULT 0,
  first_failed_at      TIMESTAMPTZ,
  last_checked_at      TIMESTAMPTZ,
  multi_location       JSONB,                                     -- was TEXT JSON
  salary_text          TEXT,
  salary_min           NUMERIC,                                   -- was REAL
  salary_max           NUMERIC,
  salary_unit          TEXT,
  normalized_key       TEXT,
  hidden               BOOLEAN     NOT NULL DEFAULT false,
  season               JSONB                                      -- was TEXT JSON
);

CREATE INDEX idx_internships_score          ON internships(score DESC NULLS LAST);
CREATE INDEX idx_internships_source         ON internships(source);
CREATE INDEX idx_internships_seen_at        ON internships(seen_at DESC);
CREATE INDEX idx_internships_applied        ON internships(applied);
CREATE INDEX idx_internships_archived       ON internships(archived);
CREATE INDEX idx_internships_score_label    ON internships(score_label);
CREATE INDEX idx_internships_is_new         ON internships(is_new);
CREATE INDEX idx_internships_company        ON internships(company);
CREATE INDEX idx_internships_normalized_key ON internships(normalized_key);
CREATE INDEX idx_internships_hidden         ON internships(hidden);

CREATE TABLE seen_ids (
  id TEXT PRIMARY KEY
);
```

### Type translation gotchas

| SQLite | Postgres | Notes |
|---|---|---|
| `TEXT` (ISO date) | `TIMESTAMPTZ` | Postgres stores actual timestamps. Need conversion on read + write. |
| `INTEGER 0/1` | `BOOLEAN` | `better-sqlite3` returns numbers; `pg` returns booleans. Code touching these flags needs updates. |
| `TEXT` JSON | `JSONB` | Postgres parses on write; reads come back as parsed objects, not strings. Drop `JSON.parse`/`JSON.stringify` calls. |
| `REAL` | `NUMERIC` | For salary fields. `pg` returns strings by default — see "pg numeric quirk" below. |
| `?` placeholders | `$1, $2, ...` | Postgres uses numbered placeholders. |
| Named: `@field` | Named not native | Use `pg-format` or hand-build `$1, $2` from object keys. |
| `db.exec(sql)` | `db.query(sql)` | Async. All callers become `await`. |
| `INSERT OR REPLACE` | `INSERT ... ON CONFLICT (id) DO UPDATE SET ...` | Postgres upsert syntax. |
| `db.transaction()` | `BEGIN; ...; COMMIT;` | Wrap in `client.query('BEGIN')` / `COMMIT` / `ROLLBACK`. |

### pg numeric quirk

`pg` returns `NUMERIC` columns as **strings** to avoid JS float precision loss. For salary fields, either:
- Set `types.setTypeParser(1700, parseFloat)` globally (loses precision for very large numbers — fine here)
- Or coerce at read sites

Go with the global setter.

## 4. Data migration script

One-shot Node script that reads SQLite and writes Postgres. Run locally, against the prod `DATABASE_URL`:

```ts
// scripts/migrate-sqlite-to-postgres.ts
import Database from 'better-sqlite3';
import { Pool } from 'pg';

const sqlite = new Database('./data/internships.db', { readonly: true });
const pg = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const rows = sqlite.prepare('SELECT * FROM internships').all() as any[];
  console.log(`Migrating ${rows.length} rows...`);

  const client = await pg.connect();
  await client.query('BEGIN');
  try {
    // Truncate if re-running
    await client.query('TRUNCATE internships, seen_ids');

    const cols = [
      'id','title','company','location','description','link','source',
      'ats_source','ats_job_id','ats_target','posted_at','seen_at',
      'score','score_label','matched_keywords','is_new','applied',
      'archived','applied_at','application_url','application_status',
      'failed_check_count','first_failed_at','last_checked_at',
      'multi_location','salary_text','salary_min','salary_max','salary_unit',
      'normalized_key','hidden','season',
    ];
    const placeholders = cols.map((_,i) => `$${i+1}`).join(',');
    const insertSql = `INSERT INTO internships (${cols.join(',')}) VALUES (${placeholders})`;

    let n = 0;
    for (const r of rows) {
      const values = [
        r.id, r.title, r.company, r.location, r.description, r.link, r.source,
        r.ats_source, r.ats_job_id, r.ats_target,
        r.posted_at,                          // TIMESTAMPTZ accepts ISO strings
        r.seen_at,
        r.score, r.score_label,
        r.matched_keywords,                   // JSONB accepts JSON strings
        !!r.is_new, !!r.applied, !!r.archived,
        r.applied_at, r.application_url, r.application_status,
        r.failed_check_count, r.first_failed_at, r.last_checked_at,
        r.multi_location, r.salary_text, r.salary_min, r.salary_max, r.salary_unit,
        r.normalized_key, !!r.hidden, r.season,
      ];
      await client.query(insertSql, values);
      if (++n % 1000 === 0) console.log(`  ${n}/${rows.length}`);
    }

    const seen = sqlite.prepare('SELECT id FROM seen_ids').all() as { id: string }[];
    for (const s of seen) {
      await client.query('INSERT INTO seen_ids (id) VALUES ($1) ON CONFLICT DO NOTHING', [s.id]);
    }

    await client.query('COMMIT');
    console.log(`Migrated ${n} internships, ${seen.length} seen_ids`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pg.end();
    sqlite.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
```

**Run order (critical):**
1. First migrate **prod** data → Postgres (locally, with prod's `DATABASE_URL`). This populates Postgres with the real ~7k rows.
2. Verify row count matches: `SELECT COUNT(*) FROM internships` should equal `sqlite3 prod-snapshot.db "SELECT COUNT(*) FROM internships"`.
3. Don't worry about local — once code switches over, both envs share one DB.

## 5. Code changes

### 5a. New file: `src/lib/db.ts`

Central pg pool. Replaces the scattered `new Database(...)` calls.

```ts
import { Pool } from 'pg';
import { types } from 'pg';

// Return NUMERIC as float, not string. Fine for salary precision.
types.setTypeParser(1700, parseFloat);

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL not set');
    }
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      // Railway proxies sometimes need this — try without first, add if you see EHOSTUNREACH
      // ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) { await _pool.end(); _pool = null; }
}
```

### 5b. Rewrite `src/lib/store.ts`

This is the bulk of the work. The file has ~40 DB call sites and the boot migrations (`applyColumnMigrations`, `deduplicateExistingRows`).

**Strategy:** keep the public API (`deduplicateAndStore`, `getInternships`, `patchInternship`, etc.) identical so callers don't break. Replace internals.

Key changes per function:
- `db.prepare(sql).run(params)` → `await pool.query(sql, [params])`
- `db.prepare(sql).all(params)` → `(await pool.query(sql, [params])).rows`
- `db.transaction(fn)(...)` → wrap in `client.query('BEGIN')`/`COMMIT`/`ROLLBACK` pattern
- Boolean returns: `row.applied === 1` → `row.applied === true` (or just `if (row.applied)`)
- Date returns: postgres returns `Date` objects; serialize back to ISO if API expects strings
- `INSERT OR REPLACE` → `INSERT ... ON CONFLICT (id) DO UPDATE SET col = EXCLUDED.col, ...`

**Boot migrations:** the existing `applyColumnMigrations` does schema patching that's specific to SQLite (ALTER TABLE ADD COLUMN with no IF NOT EXISTS). For Postgres, replace with a single schema-creation script run at boot:

```ts
async function ensureSchema(): Promise<void> {
  const pool = getPool();
  // Idempotent — uses IF NOT EXISTS throughout.
  await pool.query(`<schema SQL from section 3>`);
  // Then keep the data migrations (nan-purge, emoji-strip, dedup):
  await pool.query(`DELETE FROM internships WHERE company = 'nan'`);
  // ... etc, translated to pg syntax
}
```

### 5c. Test infrastructure

Currently `DATA_DIR=./test-data npx tsx scripts/seed-test-db.ts` writes a fresh SQLite. For Postgres:

**Option A (easier):** spin up an ephemeral Postgres via `pg-mem` (in-memory pg-compatible) for tests. Set `DATABASE_URL=memory://test` and have `getPool()` branch on that.

**Option B (more correct):** use a separate `DATABASE_URL_TEST` pointing to a `..._test` schema or DB. `seed-test-db.ts` truncates + reseeds.

Recommend B — pg-mem doesn't support all Postgres features (notably some JSONB ops) and may not behave identically.

Steps:
1. Create a second DB in Railway: `railway add postgres test` (or use a separate schema)
2. Add `DATABASE_URL_TEST` to `.env`
3. `seed-test-db.ts` connects to test DB, runs schema, inserts fixtures
4. `test-with-server.ts` spawns Next.js with `DATABASE_URL=$DATABASE_URL_TEST`

### 5d. Script updates

Files that directly open SQLite:
- `scripts/rescore-all.ts`
- `scripts/check-trim-preview.ts`
- `scripts/cleanup-markdown-descriptions.ts`

All three use the same `new Database(DB_PATH)` pattern. Replace with `import { getPool } from '../src/lib/db'`. Each script's body becomes `await`-heavy.

### 5e. Deployment config

- **`Dockerfile`** — remove the SQLite volume mount logic if any (Railway service no longer needs `/app/data` to persist for the DB; it's still needed for other runtime state like seen.json, handshake-auth, etc.)
- **`docker-entrypoint.sh`** — unchanged (still seeds config files from defaults). The `internships.db` files in `/app/data` become dead weight after migration; can clean up later.
- **`railway.json`** — no change needed; `DATABASE_URL` is auto-injected from the Postgres service.
- **Environment variables on Railway** — verify `DATABASE_URL` shows up under the `internship-tracker` service variables (Railway auto-shares it from linked Postgres).

## 6. Testing strategy

Before declaring success, verify in this order:

1. **Schema integrity** — `psql $DATABASE_URL -c "\d internships"` shows all 32 columns with expected types.
2. **Row count parity** — `SELECT COUNT(*) FROM internships` matches the pre-migration SQLite count exactly.
3. **Sample row diff** — pick 5 known rows by `id`, compare every field between SQLite snapshot and Postgres. Should be byte-identical except for the type-converted ones (dates as TIMESTAMPTZ, booleans as true/false).
4. **`npm test`** — full suite passes (73/79 + the 6 server-required when `test:full` runs).
5. **Manual UI smoke** — `npm run dev`, page loads, search works, applied toggle works, hide works, refresh button works. Each touches a different store.ts function.
6. **One poll cycle** — `npm run poller` once. New rows should write cleanly via `deduplicateAndStore`. No "stuck" rows.

## 7. Deployment / cutover

Order matters here — minimize the window where prod might write to one DB and read from another:

1. **Stop the prod poller** (briefly) — `railway service pause` or set the supervisor sleep to a huge value. Goal: nothing writing to SQLite during the migration.
2. **Snapshot prod SQLite** — `railway ssh "cp /app/data/internships.db /app/data/internships.db.pre-pg-migrate"`.
3. **Run `scripts/migrate-sqlite-to-postgres.ts` locally** with prod `DATABASE_URL`. Logs row count.
4. **Verify row count** in Postgres matches the snapshot.
5. **Deploy new code** (with pg code paths). Wait for build to finish.
6. **Resume poller**. Watch first cycle's logs — should see successful Postgres writes, no SQLite errors.
7. **Verify in UI** — hard-refresh; rows present, filters work.
8. **Leave the old SQLite file in place for 48 hours** as rollback insurance. After that, delete.

**Estimated downtime:** 5–15 minutes (mostly the build + first poll cycle verification). UI is read-only during this window — users see stale data but nothing breaks.

## 8. Rollback plan

If something's wrong after cutover:

1. **Rollback code** — `git revert <pg-migration-commit>` + push. Railway redeploys the previous SQLite code.
2. **No data loss** — the SQLite file is still at `/app/data/internships.db.pre-pg-migrate`; restore: `railway ssh "mv /app/data/internships.db.pre-pg-migrate /app/data/internships.db"`.
3. **Postgres data stays as-is** — can investigate later, retry migration when ready.

Any rows that were written to Postgres after cutover are lost on rollback. The poller runs every ~5 min so worst case you lose ~one cycle's worth (~50 rows).

## 9. Sequenced task list

Open this doc in one terminal, work through the list:

- [ ] Provision Railway Postgres add-on
- [ ] Pull `DATABASE_URL`, add to local `.env`
- [ ] Snapshot prod SQLite to `/tmp/prod-snapshot.db`
- [ ] Write `src/lib/db.ts` (the pool helper)
- [ ] Create the schema SQL file at `migrations/001_initial.sql`
- [ ] Run the schema against Postgres manually: `psql $DATABASE_URL -f migrations/001_initial.sql`
- [ ] Write `scripts/migrate-sqlite-to-postgres.ts`
- [ ] Run it against the local SQLite first as a smoke test
- [ ] Compare row counts between local SQLite and Postgres — should match
- [ ] Rewrite `src/lib/store.ts` (the big one — split across multiple commits if useful)
- [ ] Update three scripts: `rescore-all.ts`, `check-trim-preview.ts`, `cleanup-markdown-descriptions.ts`
- [ ] Update `seed-test-db.ts` and `test-with-server.ts` for the test DB
- [ ] `npm test` clean
- [ ] `npm run dev` + manual UI smoke test
- [ ] `npm run poller` once + verify rows insert
- [ ] Commit + push (do not deploy yet — staging-style review)
- [ ] Pause prod poller via Railway dashboard
- [ ] Snapshot prod SQLite
- [ ] Run migration script with prod `DATABASE_URL` from local
- [ ] Verify Postgres row counts
- [ ] Trigger Railway redeploy
- [ ] Resume poller
- [ ] Verify first cycle's logs + UI smoke test
- [ ] Wait 48h, then delete the SQLite file on Railway

## 10. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `pg` connection limits hit during boot migrations | Medium | Use a single client for migration script, not the pool |
| Type coercion bugs (string vs Date, 0/1 vs boolean) | High | The sample-row diff in section 6.3 catches these |
| Boolean filter queries silently return wrong results | High | Make `applied = 0` / `applied = 1` → `applied = false` / `true` mechanically with grep |
| Index missing → some query slow | Low | All indexes from SQLite carried forward; check `EXPLAIN` if anything is slow |
| Railway Postgres pricing higher than expected | Low | First-month free trial; ~$5/mo for small Postgres |
| Data loss during cutover | Low | Snapshot + rollback procedure in section 8 |

---

## TL;DR

1. Provision Postgres on Railway.
2. Translate schema (8 type changes — TIMESTAMPTZ, BOOLEAN, JSONB, NUMERIC).
3. Write a one-shot data migration script.
4. Rewrite `src/lib/store.ts` keeping the public API identical.
5. Update 3 scripts and the test seeder.
6. Cutover: pause poller → snapshot → migrate → deploy → resume.
7. ~5-15 min downtime; rollback path available for 48h.
