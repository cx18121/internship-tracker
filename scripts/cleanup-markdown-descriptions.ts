// One-shot cleanup for description artifacts in the existing DB:
//   1. Markdown markers from JobSpy's old description_format="markdown"
//      (backslash-escaped punctuation, **bold**, ### headings, [links](urls)).
//   2. Undecoded HTML entities (&nbsp;, &amp;, &#39;, &#8217;) from legacy
//      rows stored before stripHtml's entity decoder was applied.
//   3. Handshake mobile-app marketing banner ("Describe your goals…")
//      captured as the entire description body.
//   4. Test/synthetic rows (TEST source, XSTestCo_* companies) that leaked
//      into the live DB from earlier test runs.
//   5. Rows where the company name leaked as the literal string "nan"
//      (pd.NaN stringification from JobSpy/Indeed).
//
// Run dry:    APPLY=0 npx tsx scripts/cleanup-markdown-descriptions.ts
// Run apply:  APPLY=1 npx tsx scripts/cleanup-markdown-descriptions.ts

import 'dotenv/config';
import { getPool, closePool } from '../src/lib/db';
import { decodeHtmlEntities } from '../src/poller/utils/html';
import { smartTrimDescription, HANDSHAKE_PROMO_BANNER_SOURCE } from '../src/poller/utils/description-trim';

const APPLY = process.env.APPLY === '1';

// Standard CommonMark escapable punctuation set.
const MD_ESCAPABLE = '!"#$%&\'()*+,\\-./:;<=>?@\\[\\]^_`{|}~';

// Banner pattern is the single source-of-truth in description-trim.ts; this
// reconstitutes the RegExp from the shared source string so handshake.ts (which
// can't import RegExp objects across the page.evaluate boundary) and this
// script stay aligned.
const HANDSHAKE_BANNER_RE = new RegExp(HANDSHAKE_PROMO_BANNER_SOURCE, 'gi');

function stripMarkdown(s: string): string {
  return s
    .replace(new RegExp(`\\\\([${MD_ESCAPABLE}])`, 'g'), '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1');
}

function cleanDescription(s: string): string {
  // Order matters: decode entities first so any markdown-escape chars hidden
  // inside `&amp;#XX;` patterns surface before stripMarkdown runs.
  let out = decodeHtmlEntities(s);
  out = stripMarkdown(out);
  out = out.replace(HANDSHAKE_BANNER_RE, '');
  // Collapse only horizontal whitespace runs — newlines mark paragraph
  // breaks (stripHtml replaces <br> with \n upstream) and must survive.
  out = out.replace(/[ \t]+/g, ' ');
  // Cap blank-line runs at one (preserve paragraph breaks, drop walls).
  out = out.replace(/\n{3,}/g, '\n\n');
  // Drop benefits/EEO/legal/meta tail and cap to UI-friendly length.
  // Matches what agent.ts now does on the forward path.
  out = smartTrimDescription(out.trim());
  return out;
}

async function main(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string; source: string; company: string; title: string; description: string | null;
  }>(`SELECT id, source, company, title, description FROM internships`);

  const toUpdate: { id: string; before: string; after: string; source: string }[] = [];
  const toClear: { id: string; source: string; reason: string }[] = [];
  const toDelete: { id: string; source: string; title: string; reason: string }[] = [];

  for (const r of rows) {
    if (r.source === 'TEST' || /^XSTestCo[_-]/.test(r.company) || /^XSTest/.test(r.title)) {
      toDelete.push({ id: r.id, source: r.source, title: r.title, reason: 'test row' });
      continue;
    }

    if (r.company === 'nan' || r.company === 'NaN' || r.company === 'None') {
      toDelete.push({ id: r.id, source: r.source, title: r.title, reason: 'nan company' });
      continue;
    }

    if (!r.description) continue;

    const cleaned = cleanDescription(r.description);
    if (cleaned !== r.description.trim()) {
      if (cleaned.length < 50) {
        toClear.push({ id: r.id, source: r.source, reason: 'banner/empty after clean' });
      } else {
        toUpdate.push({ id: r.id, before: r.description, after: cleaned, source: r.source });
      }
    }
  }

  console.log(`Rows to delete: ${toDelete.length}`);
  const delBy = new Map<string, number>();
  for (const d of toDelete) delBy.set(d.reason, (delBy.get(d.reason) ?? 0) + 1);
  for (const [reason, n] of delBy) console.log(`  ${reason.padEnd(20)} ${n}`);

  console.log(`\nDescriptions to clear (banner-only / empty after clean): ${toClear.length}`);
  const clearBy = new Map<string, number>();
  for (const c of toClear) clearBy.set(c.source, (clearBy.get(c.source) ?? 0) + 1);
  for (const [src, n] of clearBy) console.log(`  ${src.padEnd(20)} ${n}`);

  console.log(`\nDescriptions to clean (entities/markdown stripped): ${toUpdate.length}`);
  const updBy = new Map<string, number>();
  for (const u of toUpdate) updBy.set(u.source, (updBy.get(u.source) ?? 0) + 1);
  for (const [src, n] of [...updBy.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src.padEnd(20)} ${n}`);
  }

  if (toUpdate.length > 0) {
    console.log(`\nSample (first 3 cleanings — diff visible chars):`);
    for (const u of toUpdate.slice(0, 3)) {
      console.log(`  --- [${u.source}] ${u.id} ---`);
      console.log(`  BEFORE: ${u.before.slice(0, 220).replace(/\n/g, ' ')}`);
      console.log(`  AFTER:  ${u.after.slice(0, 220).replace(/\n/g, ' ')}`);
    }
  }

  if (!APPLY) {
    console.log(`\n[DRY RUN] No changes made. Re-run with APPLY=1 to commit.`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of toUpdate) {
      await client.query('UPDATE internships SET description = $1 WHERE id = $2', [u.after, u.id]);
    }
    for (const c of toClear) {
      await client.query('UPDATE internships SET description = NULL WHERE id = $1', [c.id]);
    }
    for (const d of toDelete) {
      await client.query('DELETE FROM internships WHERE id = $1', [d.id]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  console.log(
    `\n[APPLIED] Cleaned ${toUpdate.length}, cleared ${toClear.length}, deleted ${toDelete.length}.`,
  );
}

main()
  .catch(err => { console.error('[cleanup-markdown] failed:', err); process.exitCode = 1; })
  .finally(async () => { await closePool(); });
