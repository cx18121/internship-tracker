import fs from "fs";
import path from "path";
import type { Internship } from "./types.js";

// ---------------------------------------------------------------------------
// Role Match (0-50 pts) — SWE / Backend / ML / QA all equal
// ---------------------------------------------------------------------------

function scoreRoleMatch(title: string): number {
  const lower = title.toLowerCase();

  const isRelevantIntern =
    /\bswe\s*intern\b/i.test(lower)
    || /\bsoftware\s*engineer(?:ing)?\s*intern(?:ship)?\b/i.test(lower)
    || /\bsummer\s*intern\b/i.test(lower)
    || /\bsoftware\s*developer\s*intern\b/i.test(lower)
    || /\bcs\s*intern\b/i.test(lower)
    || /\bcomputer\s*science\s*intern\b/i.test(lower)
    || /\b(backend|back-end|ml|machine\s*learning|ai|data\s*engineer|data\s*scientist)\s*intern/i.test(lower)
    || /\bintern.*\b(backend|back-end|ml|machine\s*learning|ai|data\s*engineer|data\s*scientist)/i.test(lower)
    || /\b(qa|devops|sre|platform|reliability|infrastructure)\s*intern/i.test(lower)
    || /\bintern.*\b(qa|devops|sre|platform|reliability|infrastructure)/i.test(lower);

  const generic = /\bintern/i.test(lower);
  if (!generic) return 0;
  return isRelevantIntern ? 50 : 15;
}

// ---------------------------------------------------------------------------
// Tech Keywords in Title (0-25 pts)
// ---------------------------------------------------------------------------

const TECH_KEYWORDS: [string, number][] = [
  ['python',5],['golang',5],['javascript',5],['typescript',5],
  ['react',5],['reactjs',5],['vue',4],['angular',4],['node',4],['nodejs',4],
  ['java ',5],['c++',4],['c#',4],['rust',5],['swift',4],['kotlin',4],
  ['sql',5],['aws',5],['amazon web services',5],['gcp',5],['google cloud',5],
  ['azure',4],['docker',5],['kubernetes',5],['k8s',5],
  ['tensorflow',5],['pytorch',5],['spark',4],['hadoop',3],['flink',3],
  ['kafka',4],['ml ',4],['ai ',4],['machine learning',5],
  ['backend',5],['full-stack',5],['frontend',4],['cloud',4],
  ['devops',5],['sre',4],['security',3],['cyber',3],
  ['network',3],['systems',3],['distributed',4],
  ['infrastructure',4],['platform',3],['api',3],['microservice',4],
  ['postgres',4],['postgresql',4],['mongodb',4],['redis',4],
];

function scoreTechKeywords(title: string, company: string): number {
  const text = `${title} ${company}`.toLowerCase();
  let pts = 0;
  for (const [kw, p] of TECH_KEYWORDS) {
    if (text.includes(kw)) { pts += p; if (pts >= 25) break; }
  }
  return Math.min(pts, 25);
}

// ---------------------------------------------------------------------------
// Company Tier (0-15 pts) — now part of base
// ---------------------------------------------------------------------------

const YC_COMPANIES = new Set([
  'airbnb','stripe','dropbox','reddit','coinbase','doordash','instacart',
  'notion','brex','ramp','linear','vercel','figma','databricks','plaid',
  'optimizely','heroku','docker','kickstarter','discourse','humu','lattice',
  'rippling','runway','scale','together','anyscale','cohere','convex',
  'descript','inngest','mistral','neon','openai','perplexity','pinecone',
  'planetscale','playwright','replicate','supabase','typebot','sweep',
  'tailscale','llmstack','merge','prisma','amplitude','zendesk','twilio',
  'groupon','hubspot','intercom','keen','loyal','braintree','balance',
  'sentry','segment','workato','zapier','calendly','carrd','chainalysis',
  'crunchbase','dbt','duckduckgo','easypost','freshworks','gong','greenhouse',
  'guidewheel','gusto','hippo','homebound','hired','incident','jasper',
  'klaviyo','launchdarkly','lean','letta','luma','lyft','matter','mercari',
  'mercury','miro','mongodb','netlify','okta','opensea','openphone',
  'pinterest','plex','public','redfin','rest','retool','rocket','salesforce',
  'samsara','shopify','shutterstock','slack','snapchat','spotify','squares',
  'statuspage','support','tesla','tiktok','trello','twitch','uber','webflow',
  'yelp','youtube','zilla','zip','zoom',
]);

const FAANG_UNICORN = new Set([
  'amazon','amzn','google','alphabet','meta','facebook','apple',
  'microsoft','nvidia','netflix','snowflake','salesforce','oracle','adobe',
  'intel','amd','qualcomm','spacex','twitter','uber','lyft','chime',
  'robinhood','etsy','cloudflare','fastly','datadog','new relic','hashicorp',
  'cockroachdb','yugabyte','timescale','hasura','appwrite','netlify','miro',
  'loom','asana','monday','github','gitlab','atlassian','spotify','discord',
  'shopify','square','block','plaid','instacart','coinbase','airbnb','snap',
  'pinterest','linkedin','twilio',
]);

function scoreCompany(company: string): number {
  if (!company) return 0;
  const lower = company.toLowerCase().trim();
  if (YC_COMPANIES.has(lower)) return 15;
  if (FAANG_UNICORN.has(lower)) return 15;
  // Partial match
  for (const n of YC_COMPANIES) {
    if (lower.includes(n) || n.includes(lower)) return 15;
  }
  for (const n of FAANG_UNICORN) {
    if (lower.includes(n) || n.includes(lower)) return 15;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Location (0-5 pts)
// ---------------------------------------------------------------------------

const US_HUBS = new Set([
  'new york','nyc','sf','san francisco','seattle','austin','boston',
  'los angeles','la','chicago','denver','atlanta','washington','dc',
  'mountain view','palo alto','menlo park','cupertino','sunnyvale',
  'berkeley','san jose','portland','san diego','phoenix','charlotte',
]);

function scoreLocation(location: string): number {
  if (!location) return 0;
  const lower = location.toLowerCase();
  if (lower.includes('remote') || lower.includes('work from home')) return 5;
  if (US_HUBS.has(lower)) return 5;
  for (const hub of US_HUBS) {
    if (lower.includes(hub)) return 4;
  }
  if (lower.includes('usa') || lower.includes('united states') || /\bUS\b/.test(location)) return 3;
  return 1; // international
}

// ---------------------------------------------------------------------------
// Freshness (0-5 pts)
// ---------------------------------------------------------------------------

function scoreFreshness(postedAt: string | undefined): number {
  if (!postedAt) return 0;
  const ageDays = (Date.now() - new Date(postedAt).getTime()) / 86400000;
  if (ageDays <= 7)  return 5;
  if (ageDays <= 14) return 4;
  if (ageDays <= 30) return 3;
  if (ageDays <= 60) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface ScoreResult {
  score: number;
  scoreLabel: 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: { roleMatch: number; techKeywords: number; company: number; location: number; freshness: number; };
  matchedKeywords: string[];
}

export function scoreInternship(entry: Partial<Internship>): ScoreResult {
  const rolePts   = scoreRoleMatch(entry.title ?? '');
  const techPts   = scoreTechKeywords(entry.title ?? '', entry.company ?? '');
  const coPts     = scoreCompany(entry.company ?? '');
  const locPts    = scoreLocation(entry.location ?? '');
  const freshPts  = scoreFreshness(entry.postedAt);

  const score = rolePts + techPts + coPts + locPts + freshPts;

  let scoreLabel: ScoreResult['scoreLabel'];
  if      (score >= 75) scoreLabel = 'A';
  else if (score >= 60) scoreLabel = 'B';
  else if (score >= 45) scoreLabel = 'C';
  else if (score >= 25) scoreLabel = 'D';
  else                  scoreLabel = 'F';

  return {
    score, scoreLabel,
    breakdown: { roleMatch: rolePts, techKeywords: techPts, company: coPts, location: locPts, freshness: freshPts },
    matchedKeywords: [],
  };
}

const isMain = require.main === module;
if (isMain) {
  const STORE = path.join(process.cwd(), 'data', 'internships.json');
  let data: Internship[] = JSON.parse(fs.readFileSync(STORE, 'utf8'));

  const scored: (Internship & { score: number; scoreLabel: string })[] = [];
  for (const e of data) {
    const r = scoreInternship(e);
    e.score = r.score;
    e.scoreLabel = r.scoreLabel;
    e.matchedKeywords = [];
    scored.push(e as Internship & { score: number; scoreLabel: string });
  }

  const gradeCounts: Record<string, number> = {};
  for (const p of scored) gradeCounts[p.scoreLabel] = (gradeCounts[p.scoreLabel]||0)+1;
  const sorted = scored.sort((a,b)=>b.score-a.score);
  const avg = (scored.reduce((s,p)=>s+p.score,0)/scored.length).toFixed(1);

  console.log(`\n=== Scoring Complete ===`);
  console.log(`Total: ${scored.length}  |  Avg: ${avg}`);
  console.log(`A:${gradeCounts['A']??0}  B:${gradeCounts['B']??0}  C:${gradeCounts['C']??0}  D:${gradeCounts['D']??0}  F:${gradeCounts['F']??0}`);
  console.log(`Max score: ${sorted[0]?.score}`);
  console.log(`\nTop 10:`);
  for (const p of sorted.slice(0,10))
    console.log(`  [${p.scoreLabel}] ${p.score} — ${p.company} | ${p.title.slice(0,45)} | ${p.location}`);

  fs.writeFileSync(STORE, JSON.stringify(scored, null, 2));
}
