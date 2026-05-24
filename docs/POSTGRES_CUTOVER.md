# Postgres Cutover Runbook

Single-screen checklist for the prod cutover after the pg-migration branch
lands. Assumes the branch has been merged to `main` and you're about to
deploy.

**Expected downtime:** 5–15 minutes (build + first poll cycle verification).

## Pre-cutover

- [ ] Branch merged to `main` and pushed.
- [ ] Verify Postgres has the migrated prod data (last seeded from a snapshot
      during the pg-migration session):
      ```
      psql $DATABASE_URL -c "SELECT COUNT(*) FROM internships;"
      ```
      Should match the snapshot row count from session-time (~6,974).

## Cutover

1. **Pause the prod poller.** SSH in and stop the supervisor's child poller
   (the supervisor runs both the web server and the poller; we only want to
   pause the poller, not the web).

   ```
   railway ssh --service internship-tracker pkill -f 'tsx src/poller/index.ts'
   ```

   The supervisor will respawn it after a short delay, so this is a
   delay-not-stop. For a hard pause, edit `POLL_INTERVAL_MS_SLOW` to a large
   value via Railway variables, then redeploy.

2. **Snapshot the live SQLite one more time** (insurance against losing rows
   written between the migration-session snapshot and now):

   ```
   # On the dev machine, base64-stream both files out:
   railway ssh --service internship-tracker -- base64 /app/data/internships.db \
     > /tmp/cutover-snapshot.db.b64
   railway ssh --service internship-tracker -- base64 /app/data/internships.db-wal \
     > /tmp/cutover-snapshot.db-wal.b64
   base64 -D -i /tmp/cutover-snapshot.db.b64 -o /tmp/cutover-snapshot.db
   base64 -D -i /tmp/cutover-snapshot.db-wal.b64 -o /tmp/cutover-snapshot.db-wal
   ```

3. **Re-run the migration with `--force`** to overwrite the Postgres rows that
   were seeded during the dev session:

   ```
   npx tsx scripts/migrate-sqlite-to-postgres.ts --src=/tmp/cutover-snapshot.db --force
   ```

4. **Verify row counts** match the live snapshot:

   ```
   psql $DATABASE_URL -c "SELECT COUNT(*) FROM internships;"
   # Compare against snapshot:
   node -e "const D=require('better-sqlite3'); console.log(new D('/tmp/cutover-snapshot.db', {readonly:true}).prepare('SELECT COUNT(*) as c FROM internships').get().c)"
   ```

5. **Trigger Railway redeploy** (only needed if branch hasn't been
   auto-deployed already by the push to main):

   ```
   railway redeploy --service internship-tracker
   ```

6. **Watch the deploy logs** until the supervisor reports both the web
   server and poller have started cleanly:

   ```
   railway logs --service internship-tracker | head -40
   ```

   Look for `[internship-tracker] Starting agent.` and no `DATABASE_URL is
   not set` errors.

7. **Smoke-test the UI** — hard refresh https://internship-tracker-production-28d6.up.railway.app
   — list loads, search works, click "applied" on a row, refresh, applied
   state persists.

8. **Watch one poll cycle complete** — should appear within 15 minutes
   (fast tier). Logs should show `[agent] Fetched N raw postings from
   SimplifyJobs` followed by a non-error `[agent] N new postings stored`.

## Rollback (within 48h)

If something's wrong post-cutover:

1. **Revert the merge commit** on `main`:
   ```
   git revert -m 1 <merge-commit-sha>
   git push origin main
   ```
   Railway redeploys the previous (SQLite) code automatically.

2. **The SQLite file is still on the Railway volume** at
   `/app/data/internships.db` — the new pg code never wrote to it, so it's
   the exact state from cutover time. Any rows written to Postgres
   post-cutover are lost on rollback (worst case: ~one fast-tier cycle's
   worth, ~50 rows).

3. **Postgres data stays as-is** — investigate the failure offline, retry
   the migration when ready.

## Post-cutover cleanup

Cleanup completed 2026-05-24 (same session as cutover, ~15 min after deploy):

- [x] Deleted `/app/data/internships.db` on the Railway volume.
- [x] Removed `better-sqlite3` + `@types/better-sqlite3` from `package.json`.
- [x] Deleted `scripts/migrate-sqlite-to-postgres.ts` + `scripts/smoke-poll.ts`.
- [ ] Optionally shrink the Railway volume from 5GB → 1GB (only JSON
      sidecar files + handshake-auth remain, total ~200MB).

Rollback escape hatch is **gone** — the SQLite file no longer exists on the
volume. Any future "go back to SQLite" would require a full restore from the
last snapshot at `/tmp/cutover-snapshot.db` on the dev machine.
