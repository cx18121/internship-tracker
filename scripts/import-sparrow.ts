/**
 * Import Sparrow's venture-backed company slice into the tracker's company
 * catalog (company_facts) and discover their ATS boards.
 *
 * Facts feed the company judgment as evidence. Boards join the hourly poll.
 * Only companies with a signal (a named round, an investor tag, or a YC
 * batch) are imported; the rest add nothing the classifier can use.
 *
 * Usage:
 *   SPARROW_DATABASE_URL=... DATABASE_URL=... npx tsx scripts/import-sparrow.ts            # facts only
 *   SPARROW_DATABASE_URL=... DATABASE_URL=... npx tsx scripts/import-sparrow.ts --discover  # facts + US board discovery
 *   ... --discover --limit 500 --dry-run
 *
 * Discovery probes each ATS API with the domain stem, then falls back to the
 * company's careers page and reads the ATS link out of the redirect or HTML.
 * Rerunnable: facts upsert by domain; boards already in ats-targets.json or
 * already probed (company_facts.source = 'sparrow:probed') are skipped.
 */
import 'dotenv/config';
import axios from 'axios';
import { Client } from 'pg';
import { getPool, closePool } from '../src/lib/db';
import { runMigrations } from '../src/lib/migrate';
import { upsertCompanyFacts } from '../src/lib/store';
import { loadATSTargets, saveDiscoveredTargets, type ATSTarget } from '../src/lib/utils/ats-discovery';
import { verifyAtsSlug } from '../src/poller/ats';
import { pool } from '../src/lib/concurrency';

type ATS = 'greenhouse' | 'lever' | 'ashby';
const ATS_ORDER: readonly ATS[] = ['greenhouse', 'ashby', 'lever'];
const ATS_LINK_RE = /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9][a-z0-9._-]{1,60})|jobs\.lever\.co\/([a-z0-9][a-z0-9._-]{1,60})|jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9._-]{1,60})/i;
const NON_SLUGS = new Set(['embed', 'jobs', 'careers', 'api', 'company', 'login', 'auth', 'static']);
const CAREERS_PATHS = ['/careers', '/jobs', '/careers/', '/company/careers', '/join-us', '/join', '/about/careers'];
const US_LOCATION = /\b(US|USA|United States|Bay Area|New York|San Francisco|Seattle|Boston|Los Angeles|Chicago|Austin|Denver|Remote)\b|, [A-Z]{2}$/;

interface SparrowCompany {
  name: string;
  domain: string;
  stage: string | null;
  batch: string | null;
  headcount: number | null;
  industry: string | null;
  location: string | null;
  region: string | null;
  investors: string[];
}

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

async function loadSparrow(): Promise<SparrowCompany[]> {
  const url = process.env.SPARROW_DATABASE_URL;
  if (!url) throw new Error('SPARROW_DATABASE_URL is required');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query<SparrowCompany>(`
      SELECT name, lower(regexp_replace(domain, '^www\\.', '')) AS domain, stage, batch, headcount, industry, location, region,
             array(SELECT substr(t, 10) FROM unnest(tags) t WHERE t LIKE 'investor:%') AS investors
      FROM "Company"
      WHERE stage IS NOT NULL OR batch IS NOT NULL OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'investor:%')`);
    return rows;
  } finally {
    await client.end();
  }
}

const stem = (domain: string) => domain.split('.')[0];
const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A careers page can link to an investor's portfolio board; keep only slugs that name this company. */
function sameCompany(slug: string, c: SparrowCompany): boolean {
  const s = squash(slug);
  const names = [squash(stem(c.domain)), squash(c.name)].filter(n => n.length >= 3);
  return names.some(n => s.includes(n) || n.includes(s));
}

async function findBoard(c: SparrowCompany): Promise<ATSTarget | null> {
  const s = stem(c.domain);
  for (const ats of ATS_ORDER) if (await verifyAtsSlug(s, ats)) return { slug: s, ats, name: c.name };

  for (const path of CAREERS_PATHS) {
    for (const host of [`https://${c.domain}`, `https://www.${c.domain}`]) {
      try {
        const r = await axios.get<string>(host + path, { timeout: 8000, maxRedirects: 5, validateStatus: () => true, responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0' } });
        const finalUrl = (r.request?.res?.responseUrl as string | undefined) ?? '';
        const m = finalUrl.match(ATS_LINK_RE) ?? (typeof r.data === 'string' ? r.data.match(ATS_LINK_RE) : null);
        if (!m) continue;
        const [gh, lever, ashby] = [m[1], m[2], m[3]];
        const ats: ATS = gh ? 'greenhouse' : lever ? 'lever' : 'ashby';
        const slug = (gh ?? lever ?? ashby).toLowerCase();
        if (NON_SLUGS.has(slug) || !sameCompany(slug, c)) continue;
        if (await verifyAtsSlug(slug, ats)) return { slug, ats, name: c.name };
      } catch { /* unreachable host; try the next path */ }
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const dryRun = flag('--dry-run');
  await runMigrations();

  const companies = await loadSparrow();
  console.log(`[sparrow] ${companies.length} companies with a funding, investor, or YC signal`);
  if (!dryRun) {
    const n = await upsertCompanyFacts(companies.map(c => ({ ...c, source: 'sparrow' })));
    console.log(`[sparrow] upserted ${n} facts`);
  }

  if (!flag('--discover')) return;

  const known = new Set(loadATSTargets().map(t => t.slug.toLowerCase()));
  const { rows: probed } = await getPool().query<{ domain: string }>("SELECT domain FROM company_facts WHERE source = 'sparrow:probed'");
  const probedSet = new Set(probed.map(r => r.domain));
  const limit = Number(opt('--limit') ?? Infinity);
  const candidates = companies
    .filter(c => US_LOCATION.test(`${c.region ?? ''} ${c.location ?? ''}`))
    .filter(c => !known.has(stem(c.domain)) && !probedSet.has(c.domain))
    .slice(0, limit);
  console.log(`[sparrow] probing ${candidates.length} US companies for boards`);

  const found: ATSTarget[] = [];
  let done = 0;
  await pool(candidates, 12, async (c) => {
    const t = await findBoard(c);
    if (t) { found.push(t); console.log(`[sparrow] ${c.name} → ${t.ats}/${t.slug}`); }
    if (++done % 200 === 0) console.log(`[sparrow] ${done}/${candidates.length} probed, ${found.length} boards`);
  });

  console.log(`[sparrow] found ${found.length} boards in ${candidates.length} companies`);
  if (dryRun) return;
  const added = saveDiscoveredTargets(found);
  await getPool().query("UPDATE company_facts SET source = 'sparrow:probed' WHERE domain = ANY($1::text[])", [candidates.map(c => c.domain)]);
  console.log(`[sparrow] added ${added} targets to ats-targets.json`);
}

main()
  .catch(err => { console.error('[import-sparrow] failed:', err); process.exitCode = 1; })
  .finally(() => closePool());
