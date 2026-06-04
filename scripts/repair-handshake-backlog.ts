// Backlog repair for the corrupted Handshake rows (the DOM-drift damage:
// card-dump titles and garbage company fields). Strategy: DELETE them so the
// fixed poller re-inserts clean rows for still-listed jobs. DELETE (not
// archive) avoids the resurrection problem documented for canonicalization.
//
// ORDER: run this only AFTER the fixed scraper is deployed, so the next poll
// re-inserts clean rows. (deploy-before-migrate.)
//
// Usage:
//   npx tsx scripts/repair-handshake-backlog.ts          # dry run: count + sample
//   npx tsx scripts/repair-handshake-backlog.ts --apply  # delete corrupted rows
import 'dotenv/config';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');

// A row is "corrupted" if its TITLE still carries the card-dump tail (type
// separator, in-title salary, a relative-time token, or "Unpaid ·"), OR its
// COMPANY shows a clear-garbage signal ("Internship", a $-amount, "/hr", or a
// trailing "Intern"). Clean re-scraped rows (e.g. title "Software Engineering
// Intern", company "Goalbound") match NONE of these.
const WHERE = `
  source = 'Handshake'
  AND coalesce(archived,false) = false
  AND (
       title ~ '·\\s*Internship'
    OR title ~ '\\$[0-9].*/(hr|yr|mo|hour)'
    OR title ~ '[0-9]+(wk|d|mo|h|yr)\\s+ago'
    OR title ~ 'Unpaid\\s*·'
    OR company = 'Internship'
    OR company ~ '\\$'
    OR company ~ '/hr'
    OR company ~ 'Intern$'
  )`;

(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const total = await c.query(`select count(*) n from internships where source='Handshake' and coalesce(archived,false)=false`);
  const { rows } = await c.query(`select id, company, title from internships where ${WHERE} order by company`);

  console.log(`Active Handshake rows: ${total.rows[0].n}`);
  console.log(`Corrupted (match): ${rows.length}\n`);
  for (const r of rows.slice(0, 30)) {
    console.log(`  company=${JSON.stringify(r.company)}`);
    console.log(`    title=${JSON.stringify((r.title || '').slice(0, 80))}`);
  }
  if (rows.length > 30) console.log(`  … and ${rows.length - 30} more.`);

  if (!APPLY) {
    console.log('\nDRY RUN — no writes. Re-run with --apply to DELETE these rows.');
    console.log('Run only AFTER the fixed scraper is deployed, then trigger a Handshake poll.');
    await c.end();
    return;
  }

  const ids = rows.map((r) => r.id);
  const res = await c.query(`delete from internships where id = ANY($1)`, [ids]);
  console.log(`\nDELETED ${res.rowCount} corrupted Handshake rows. Trigger a Handshake poll to re-insert clean versions.`);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
