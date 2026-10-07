import type { Degree } from './classify/posting';
import type { OpeningFacts, PostingIdentity, StoredInternship } from './types';
import { parseSeason } from './seasons';

/** Compare source names/profile handles without company aliases or word removal. */
export function employerSpelling(name: string): string {
  return name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Location labels may disappear, but trailing team/degree words must survive. */
export function roleSignature(title: string): string {
  return title.normalize('NFKC').toLowerCase()
    .replace(/\bsoftware engineering\b/g, 'software engineer')
    .replace(/\b(?:internships?|interns?|co-op|coop)\b/g, ' ')
    .replace(/\b(?:summer|spring|fall|autumn|winter|20\d{2}|remote|hybrid|onsite|on-site)\b/g, ' ')
    .replace(/\b(?:nyc|sf|new york(?: city)?|san francisco|seattle|boston|austin|chicago|us|usa)\b/g, ' ')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

const ROLE_START = /\b(?:about (?:the|this) role|(?:your |key )?responsibilities|job description|what you(?:[’']ll| will) do|during your internship you will|in this role|you will)\b/i;
const FOOTER = /\b(?:about us|about (?:the|our) company|company description|benefits(?: for|:|\n)|equal opportunity|our privacy|candidate privacy)\b/i;
const STOP_WORDS = new Set('a an the and or of to in on for with as by from at you your we our they their this that these those will would can have has be are is it its during about role intern internship team work working also'.split(' '));

/** Capture narrow explicit constraints and optional role content before any storage cap. */
export function openingFacts(description: string): OpeningFacts | undefined {
  if (!description.trim()) return undefined;
  const relevant = description.split(FOOTER)[0];
  const start = relevant.search(ROLE_START);
  const role = start < 0 ? '' : relevant.slice(start).normalize('NFKC').toLowerCase();
  const tokens = [...new Set((role.match(/[\p{L}\p{N}]+(?:\+\+|#)?/gu) ?? []).filter(t => !STOP_WORDS.has(t)))];
  const programs = new Set<Degree>(), graduateRequirements = new Set<Degree>();
  for (const sentence of relevant.split(/\n|[!?]|(?<![DdSs])\.\s+/)) {
    if (!/\b(?:must|required|requirements?|minimum|pursuing|enrolled|working towards?)\b/i.test(sentence) ||
        /\b(?:preferred|nice to have|bonus|a plus|not required)\b/i.test(sentence)) continue;
    const currentProgram = /\b(?:pursuing|enrolled|working towards?)\b/i.test(sentence);
    const target = currentProgram ? programs : graduateRequirements;
    // A completed Bachelor's degree does not mean graduate students are ineligible.
    if (currentProgram && /\b(?:bachelor(?:[’']?s)?\b|undergraduate\b|b\.?s\.?\b)/i.test(sentence)) target.add('bs');
    if (/\b(?:master(?:[’']?s)?\b|m\.?s\.?\b)/i.test(sentence)) target.add('ms');
    if (/\b(?:ph\.?d\.?|doctoral|doctorate)\b/i.test(sentence)) target.add('phd');
    if (/\bgraduate\b/i.test(sentence) && !/\bundergraduate\b/i.test(sentence) && target.size === 0) {
      target.add('ms'); target.add('phd');
    }
  }
  const allowedPrograms = [...programs].filter(d => !graduateRequirements.size || graduateRequirements.has(d));
  const degrees = allowedPrograms.length ? allowedPrograms : [...graduateRequirements];
  const teams = [...relevant.matchAll(/\b(?:team|specialization)\s*:\s*([^\n.;]{1,60})/gi)]
    .map(m => employerSpelling(m[1])).filter(Boolean);
  const qualificationsStart = relevant.search(/\b(?:requirements?|qualifications?|must|required)\b/i);
  const technicalText = role || (qualificationsStart >= 0 ? relevant.slice(qualificationsStart).normalize('NFKC').toLowerCase() : '');
  return { version: 1, roleTokens: tokens, degrees: degrees.sort(), teams: [...new Set(teams)],
    technologies: [...new Set(technicalText.match(/\b(?:c\+\+|c#|f#)(?!\w)/g) ?? [])] };
}

/** JD years alone may be graduation dates. Only internship-related dated statements count. */
export function explicitInternshipTerms(title: string, description = ''): string[] {
  const titleTerms = parseSeason(title);
  if (titleTerms.length) return titleTerms;
  return [...new Set(description.split(FOOTER)[0].split(/\n|(?<=[.!?])\s+/)
    .filter(s => /\b(?:internship|intern|program)\b/i.test(s) && !/\b(?:graduat|full.time|convert)/i.test(s))
    .flatMap(s => parseSeason(s).filter(t => !t.startsWith('year-'))))].sort();
}

function termsAgree(a: string[], b: string[]): boolean {
  return a.length === 0 || b.length === 0 || a.some(x => b.some(y =>
    x === y || ((x.startsWith('year-') || y.startsWith('year-')) && x.split('-')[1] === y.split('-')[1])));
}
function sameExplicitTerm(a: PostingIdentity[], b: PostingIdentity[]): boolean {
  return a.some(x => x.terms.some(t => !t.startsWith('year-') && b.some(y => y.terms.includes(t))));
}
function keyIssuer(key: string): string { return key.slice(0, key.lastIndexOf(':')); }
function conflicts(a: PostingIdentity[], b: PostingIdentity[], field: 'openingKey' | 'requisitionKey'): boolean {
  return a.some(x => x[field] && b.some(y => y[field] && keyIssuer(x[field]!) === keyIssuer(y[field]!) && x[field] !== y[field]));
}
function overlap(a: string[], b: string[]): number { const right = new Set(b); return a.filter(x => right.has(x)).length; }
function disjoint(a: string[], b: string[]): boolean { return a.length > 0 && b.length > 0 && overlap(a, b) === 0; }

type ContentSupport = 'supports' | 'contradicts' | 'unknown';
/** Containment tolerates shortened descriptions. Ordinary paraphrases remain unknown, not vetoes. */
export function roleContentSupport(a?: OpeningFacts, b?: OpeningFacts): ContentSupport {
  const left = a?.roleTokens ?? [], right = b?.roleTokens ?? [];
  if (Math.min(left.length, right.length) < 12) return 'unknown';
  const shared = overlap(left, right), fraction = shared / Math.min(left.length, right.length);
  if (shared >= 8 && fraction >= 0.6) return 'supports';
  // Substantial, almost disjoint responsibilities are counterevidence, not a fuzzy threshold miss.
  if (Math.min(left.length, right.length) >= 20 && fraction <= 0.08) return 'contradicts';
  return 'unknown';
}
function factsAgree(a?: OpeningFacts, b?: OpeningFacts): boolean {
  return !disjoint(a?.degrees ?? [], b?.degrees ?? []) && !disjoint(a?.teams ?? [], b?.teams ?? []) &&
    !disjoint(a?.technologies ?? [], b?.technologies ?? []) && roleContentSupport(a, b) !== 'contradicts';
}
function rolesAndTermsAgree(a: PostingIdentity[], b: PostingIdentity[]): boolean {
  return a.every(x => b.every(y => plausibleRole(x.title, y.title) && termsAgree(x.terms, y.terms)));
}
export function identitiesAgree(a: PostingIdentity[], b: PostingIdentity[]): boolean {
  return !conflicts(a, b, 'openingKey') && !conflicts(a, b, 'requisitionKey') && rolesAndTermsAgree(a, b) &&
    a.every(x => b.every(y => factsAgree(x.facts, y.facts)));
}

function retainMissingFacts(old?: OpeningFacts, incoming?: OpeningFacts): OpeningFacts | undefined {
  if (!incoming) return old;
  if (!old) return incoming;
  // Empty extraction means absent evidence, not an explicit withdrawal of a constraint.
  return { ...incoming,
    roleTokens: incoming.roleTokens.length ? incoming.roleTokens : old.roleTokens,
    degrees: incoming.degrees.length ? incoming.degrees : old.degrees,
    teams: incoming.teams.length ? incoming.teams : old.teams,
    technologies: incoming.technologies.length ? incoming.technologies : old.technologies,
  };
}

/** One current observation per source posting; preserve accepted aliases and missing facts. */
export function mergeIdentities(a: PostingIdentity[], b: PostingIdentity[]): PostingIdentity[] {
  const byKey = new Map(a.map(x => [x.postingKey, x]));
  for (const x of b) {
    const old = byKey.get(x.postingKey);
    byKey.set(x.postingKey, { ...old, ...x,
      terms: x.terms.length ? x.terms : old?.terms ?? [], openingKey: x.openingKey ?? old?.openingKey,
      requisitionKey: x.requisitionKey ?? old?.requisitionKey, employer: x.employer ?? old?.employer,
      facts: retainMissingFacts(old?.facts, x.facts),
    });
  }
  return [...byKey.values()];
}
function sharedKey(a: PostingIdentity[], b: PostingIdentity[], field: 'postingKey' | 'openingKey' | 'requisitionKey'): boolean {
  return a.some(x => x[field] && b.some(y => x[field] === y[field]));
}
function sameEmployer(a: PostingIdentity[], b: PostingIdentity[]): boolean {
  return a.some(x => x.employer && b.some(y => y.employer && employerSpelling(x.employer!.name) !== '' &&
    employerSpelling(x.employer!.name) === employerSpelling(y.employer.name)));
}
function plausibleRole(a: string, b: string): boolean {
  const leftRole = roleSignature(a), rightRole = roleSignature(b);
  if (!leftRole || !rightRole) return true; // Generic titles cannot make competing openings disappear.
  const left = leftRole.split(' '), right = rightRole.split(' ');
  return left.every(w => right.includes(w)) || right.every(w => left.includes(w));
}
function plausible(a: PostingIdentity[], b: PostingIdentity[]): boolean {
  return sameEmployer(a, b) && a.some(x => b.some(y => plausibleRole(x.title, y.title) && termsAgree(x.terms, y.terms)));
}
function postingIssuer(x: PostingIdentity): string | undefined {
  const parts = x.postingKey.split(':');
  return parts[0] !== 'url' && parts[2] === 'post' ? parts.slice(0, 2).join(':') : undefined;
}
function separateAuthoritativePosts(a: PostingIdentity[], b: PostingIdentity[]): boolean {
  return a.some(x => postingIssuer(x) && b.some(y => postingIssuer(x) === postingIssuer(y) && x.postingKey !== y.postingKey &&
    !sharedKey([x], [y], 'openingKey') && !sharedKey([x], [y], 'requisitionKey')));
}
function authoritativeGroups(evidence: PostingIdentity[]): number {
  const groups: PostingIdentity[][] = [];
  for (const x of evidence.filter(x => postingIssuer(x))) {
    const related = groups.filter(g => ['postingKey', 'openingKey', 'requisitionKey'].some(k => sharedKey([x], g, k as 'postingKey' | 'openingKey' | 'requisitionKey')));
    if (!related.length) groups.push([x]);
    else {
      related[0].push(x, ...related.slice(1).flat());
      for (const g of related.slice(1)) groups.splice(groups.indexOf(g), 1);
    }
  }
  return groups.length;
}

/** Compare PostgreSQL microseconds without truncating through JavaScript Date. */
export function compareOpportunityAge(a: StoredInternship, b: StoredInternship): number {
  const submillis = (s: string) => Number((s.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? '').padEnd(6, '0').slice(3, 6));
  return Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt) || submillis(a.firstSeenAt) - submillis(b.firstSeenAt) || a.id.localeCompare(b.id);
}

/** Storage and cleanup share opening inference, ambiguity checks and conflict guards. */
export class OpportunityIndex {
  private rows = new Map<string, StoredInternship>();
  private keys = new Map<string, Set<string>>();
  constructor(rows: StoredInternship[], private pending: StoredInternship[] = []) { for (const row of rows) this.add(row); }
  add(row: StoredInternship): void {
    this.rows.set(row.id, row);
    const add = (key: string) => {
      if (!key) return;
      if (!this.keys.has(key)) this.keys.set(key, new Set());
      this.keys.get(key)!.add(row.id);
    };
    for (const x of row.identities ?? []) {
      add(`post:${x.postingKey}`);
      if (x.openingKey) add(`opening:${x.openingKey}`);
      if (x.requisitionKey) add(`req:${x.requisitionKey}`);
      if (x.employer) add(`employer:${employerSpelling(x.employer.name)}`);
    }
  }
  get(id: string): StoredInternship | undefined { return this.rows.get(id); }
  private candidates(keys: string[], incoming: StoredInternship): StoredInternship[] {
    const ids = new Set(keys.flatMap(k => [...this.keys.get(k) ?? []]));
    return [...ids].map(id => this.rows.get(id)!).filter(r => r.id !== incoming.id).sort(compareOpportunityAge);
  }
  find(incoming: StoredInternship): StoredInternship | undefined {
    const evidence = [...this.rows.get(incoming.id)?.identities ?? [], ...incoming.identities ?? []];
    const compatible = (r: StoredInternship) => identitiesAgree(evidence, r.identities ?? []);
    const exact = this.candidates(evidence.map(x => `post:${x.postingKey}`), incoming).filter(compatible);
    if (exact.length) return exact[0];
    const opening = this.candidates(evidence.flatMap(x => [x.openingKey ? `opening:${x.openingKey}` : '', x.requisitionKey ? `req:${x.requisitionKey}` : '']), incoming)
      .filter(r => !r.archived && compatible(r));
    if (opening.length) return opening[0];

    // Plausibility is deliberately broader than positive evidence. Missing details cannot hide a competitor.
    const related = this.candidates(evidence.filter(x => x.employer).map(x => `employer:${employerSpelling(x.employer!.name)}`), incoming)
      .filter(r => !r.archived && plausible(evidence, r.identities ?? []));
    const pending = this.pending.filter(r => r.id !== incoming.id && !r.archived && plausible(evidence, r.identities ?? []));
    const all = [...evidence, ...related.flatMap(r => r.identities ?? []), ...pending.flatMap(r => r.identities ?? [])];
    if (conflicts(all, all, 'openingKey') || conflicts(all, all, 'requisitionKey') || separateAuthoritativePosts(all, all)) return undefined;
    const groups = authoritativeGroups(all);
    if (groups > 1) return undefined;
    // Named teams are separate plausible openings even if the incoming title omits the team.
    const roles = new Set(all.map(x => roleSignature(x.title)).filter(Boolean));
    if (roles.size > 1) return undefined;
    if (!groups && new Set([...related, ...pending].map(r => r.id)).size > 1) return undefined;
    const qualifiedRole = (r: StoredInternship) => evidence.some(x => roleSignature(x.title) &&
      r.identities?.some(y => roleSignature(x.title) === roleSignature(y.title)));
    const matches = related.filter(r => r.source.toLowerCase() !== incoming.source.toLowerCase() && qualifiedRole(r) && compatible(r) && (sameExplicitTerm(evidence, r.identities ?? []) ||
      evidence.some(x => r.identities?.some(y => roleContentSupport(x.facts, y.facts) === 'supports'))));
    return matches[0];
  }
}
