import type { Degree } from './classify/posting';
import type { OpeningFacts, PostingIdentity, StoredInternship } from './types';
import { parseSeason } from './seasons';
import { stripUtm } from './utils/normalize';

/** Exact application URLs, retaining job IDs and meaningful query/fragment values. */
export function sourceUrlKey(link: string): string {
  return /^https?:\/\//i.test(link) ? stripUtm(link) : '';
}

/** Resolve physical posting aliases before comparing aggregator labels. A custom
 * Greenhouse URL needs an official observation of that very URL to prove its
 * tenant. Other native IDs are already qualified. Conflicting board cohorts
 * remain counterevidence; an aggregator never resolves that ambiguity. */
function resolvePostingAliases(evidence: PostingIdentity[], other: PostingIdentity[] = [], accepted = true): PostingIdentity[] {
  // A formerly year-only extraction can be refined by its own explicit title.
  // Never replace a source-stated season with a new parser's interpretation.
  evidence = evidence.map(x => {
    const terms = parseSeason(x.title);
    return x.terms.every(t => t.startsWith('year-')) && terms.some(t => !t.startsWith('year-'))
      ? { ...x, terms } : x;
  });
  const all = [...evidence, ...other];
  const known = all.filter(x => /^greenhouse:(?!_:)[^:]+:post:\d+$/.test(x.postingKey));
  const boards = all.filter(x => x.origin === 'board' && postingIssuer(x) && !x.postingKey.includes(':_:'));
  return evidence.map(x => {
    const id = x.postingKey.match(/^greenhouse:_:post:(\d+)$/)?.[1];
    const matches = id && sourceUrlKey(x.sourceUrl)
      ? known.filter(y => y.postingKey.endsWith(`:post:${id}`) && sourceUrlKey(x.sourceUrl) === sourceUrlKey(y.sourceUrl))
      : x.origin === 'feed' ? boards.filter(y => y.postingKey === x.postingKey || (accepted &&
        x.employer?.kind === 'source' && !x.employer.hiringNames?.length && evidence.some(alias => alias.postingKey === y.postingKey))) : [];
    const keys = new Set(matches.map(y => y.postingKey));
    const consistent = !conflicts(matches, matches, 'openingKey') && !conflicts(matches, matches, 'requisitionKey') &&
      matches.every(a => matches.every(b => termsAgree(a.terms,b.terms) && factsAgree(a.facts,b.facts)));
    if (keys.size !== 1 || !consistent) return x;
    const board = matches[0];
    // Source ownership can correct weak labels, never discard known opening,
    // eligibility or explicit hiring-employer counterevidence from the feed.
    if (conflicts([x],[board],'openingKey') || conflicts([x],[board],'requisitionKey') || !factsAgree(x.facts,board.facts) ||
        (x.origin === 'board' && !termsAgree(x.terms,board.terms)) ||
        disjoint((x.employer?.hiringNames ?? []).map(employerSpelling), (board.employer?.hiringNames ?? []).map(employerSpelling))) return x;
    // An already accepted alias can have an older board path/requisition suffix.
    // Refine only its weak labels, never erase that alias or known opening IDs.
    if (id || board.postingKey === x.postingKey) return { ...board,
      openingKey: x.openingKey ?? board.openingKey, requisitionKey: x.requisitionKey ?? board.requisitionKey,
      requisitionReference: x.requisitionReference ?? board.requisitionReference,
      employer: x.employer?.hiringNames?.length ? x.employer : board.employer ?? x.employer,
      facts: retainMissingFacts(x.facts,board.facts),
    };
    return { ...x, origin: 'board', title: board.title, terms: board.terms, facts: retainMissingFacts(x.facts,board.facts) };
  });
}

/** Compare source names/profile handles without company aliases or word removal. */
export function employerSpelling(name: string): string {
  return name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Only explicit hiring-employer statements. Mentions of customers or former
 * employers do not establish whose opening this is. */
export function statedEmployers(description: string): string[] {
  return [...new Set([...description.matchAll(/(?:^|\n)\s*([^\n.!?]{1,80}?)\s+is an equal opportunity employer\b/gi)]
    .map(m => m[1].trim()))];
}
export function employerNames(x: PostingIdentity): string[] {
  if (!x.employer) return [];
  // These labels are source-local names, not global company aliases. Explicit
  // differing hiring employers veto a match even when a profile label agrees.
  return [x.employer.name, ...x.employer.hiringNames ?? []].map(employerSpelling).filter(Boolean);
}

/** Only observed location labels may refine a title; team/degree words survive. */
export function roleSignature(title: string, locations: string[] = []): string {
  let text = title.normalize('NFKC').toLowerCase();
  for (const location of locations.flatMap(l => l.split(';'))) {
    const parts = location.split(',').map(p => p.trim().normalize('NFKC').toLowerCase());
    for (let n = parts.length; n > 0; n--) {
      const label = parts.slice(0, n).join(', ');
      if (label.length < 3) continue;
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // A city can also be a role word (Mobile, Commerce). Only a complete
      // trailing location segment is a location qualifier, never a prefix.
      text = text.replace(new RegExp(`(?:\\s*[-–—|,:]\\s*|\\s*\\()${escaped}\\s*\\)?\\s*$`, 'g'), ' ');
    }
  }
  return text
    .replace(/\b(?:software engineering|software development engineer)\b/g, 'software engineer')
    .replace(/\bsw\b/g, 'software')
    .replace(/\b(?:internships?|interns?|co-op|coop)\b/g, ' ')
    .replace(/\b(?:summer|spring|fall|autumn|winter|20\d{2}|remote|hybrid|onsite|on-site)\b/g, ' ')
    .replace(/\b(?:nyc|sf|new york(?: city)?|san francisco|seattle|boston|austin|chicago|us|usa)\b/g, ' ')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

const ROLE_START = /\b(?:about (?:the|this) role|(?:your |key )?responsibilities|job description|what you(?:[’']ll| will) do|during your internship you will|in this role|you will)\b/i;
const FOOTER = /\b(?:about us|about (?:the|our) company|company description|benefits(?: for|:|\n)|equal opportunity|our privacy|candidate privacy)\b/i;
const STOP_WORDS = new Set('a an the and or of to in on for with as by from at you your we our they their this that these those will would can have has be are is it its during about role intern internship team work working also'.split(' '));

function beforeRoleFooter(description: string): string {
  // Company introductions commonly precede the duties. Only a footer after
  // the role starts can terminate that role's evidence.
  const afterStart = Math.max(description.search(ROLE_START), 0);
  const footer = description.slice(afterStart).search(FOOTER);
  return footer < 0 ? description : description.slice(0, afterStart + footer);
}

/** Capture narrow explicit constraints and optional role content before any storage cap. */
export function openingFacts(description: string): OpeningFacts | undefined {
  if (!description.trim()) return undefined;
  const relevant = beforeRoleFooter(description);
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
  return { version: 2, roleTokens: tokens, degrees: degrees.sort(), teams: [...new Set(teams)],
    technologies: [...new Set(technicalText.match(/\b(?:c\+\+|c#|f#)(?!\w)/g) ?? [])],
    durationWeeks: [...new Set([...relevant.matchAll(/\b(?:internship|intern)\s+(?:role\s+)?(?:is\s+)?(?:for|of|lasting)\s+(\d+)\s*(months?|weeks?)\b/gi)]
      .map(m => Number(m[1]) * (/month/i.test(m[2]) ? 4 : 1)))],
  };
}

/** JD years alone may be graduation dates. Only internship-related dated statements count. */
export function explicitInternshipTerms(title: string, description = ''): string[] {
  const titleTerms = parseSeason(title);
  if (titleTerms.some(t => !t.startsWith('year-'))) return titleTerms;
  const start = description.search(ROLE_START);
  // Retain a posting's introductory term statement, but not a company-history
  // section before the duties (for example, last year's internship program).
  const prefix = description.slice(0, start < 0 ? description.length : start).split(FOOTER)[0];
  const role = start < 0 ? '' : beforeRoleFooter(description).slice(start);
  const terms = [...new Set(`${prefix}\n${role}`.split(/\n|(?<=[.!?])\s+/)
    .filter(s => /\b(?:internship|intern|program|application)\b/i.test(s) &&
      !/\b(?:graduat\w*|full.time|convert\w*|not|don[’']t|separate|another|other)\b/i.test(s) &&
      (!titleTerms.length || /\bthis (?:application|internship|role|position|posting|program)\b/i.test(s)))
    .flatMap(s => parseSeason(s).filter(t => !t.startsWith('year-') &&
      (!titleTerms.length || titleTerms.includes(`year-${t.split('-')[1]}`)))))].sort();
  return terms.length && (!titleTerms.length || terms.length === 1) ? terms : titleTerms;
}

/** A source-stated requisition is not a globally qualified ATS identity. */
export function statedRequisitionReference(description: string): string | undefined {
  const values = [...description.matchAll(/(?:^|\n)\s*(?:(?:requisition|req)(?:\s+(?:id|number))?\s*[:#]\s*([\w-]{3,60})|(P-\d{3,}))\s*(?=\n|$)/gi)]
    .map(m => (m[1] ?? m[2]).toLowerCase()).filter(value => /\d/.test(value) && !/^0+$/.test(value));
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : undefined;
}

function requisitionReference(x: PostingIdentity): string | undefined {
  return (x.requisitionKey?.split(':req:')[1] ?? x.requisitionReference)?.toLowerCase();
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
/** Content-only inference must support every retained substantive observation.
 * Missing text is unknown; one verbose alias cannot bridge two unsupported roles. */
function contentCorroborates(a: PostingIdentity[], b: PostingIdentity[]): boolean {
  const left = a.filter(x => (x.facts?.roleTokens.length ?? 0) >= 12);
  const right = b.filter(x => (x.facts?.roleTokens.length ?? 0) >= 12);
  return left.length > 0 && right.length > 0 && left.every(x => right.every(y => roleContentSupport(x.facts, y.facts) === 'supports'));
}

function factsAgree(a?: OpeningFacts, b?: OpeningFacts): boolean {
  const leftDuration = a?.durationWeeks ?? [], rightDuration = b?.durationWeeks ?? [];
  const durationAgrees = !leftDuration.length || !rightDuration.length || leftDuration.some(x => rightDuration.includes(x));
  return durationAgrees && !disjoint(a?.degrees ?? [], b?.degrees ?? []) && !disjoint(a?.teams ?? [], b?.teams ?? []) &&
    !disjoint(a?.technologies ?? [], b?.technologies ?? []) && roleContentSupport(a, b) !== 'contradicts';
}
function rolesAndTermsAgree(a: PostingIdentity[], b: PostingIdentity[], leftLocations: string[], rightLocations: string[]): boolean {
  return a.every(x => b.every(y => (plausibleRole(x.title, y.title, leftLocations, rightLocations) ||
    (x.postingKey === y.postingKey && !!postingIssuer(x) && !x.postingKey.includes(':_:'))) && termsAgree(x.terms, y.terms)));

}
export function identitiesAgree(a: PostingIdentity[], b: PostingIdentity[], leftLocations: string[] = [], rightLocations: string[] = []): boolean {
  const original = a;
  a = resolvePostingAliases(a, b);
  b = resolvePostingAliases(b, original);
  return !conflicts(a, b, 'openingKey') && !conflicts(a, b, 'requisitionKey') && rolesAndTermsAgree(a, b, leftLocations, rightLocations) &&
    !a.some(x => b.some(y => (x.requisitionReference || y.requisitionReference) &&
      requisitionReference(x) && requisitionReference(y) && sameEmployer([x], [y]) &&
      requisitionReference(x) !== requisitionReference(y))) &&
    a.every(x => b.every(y => factsAgree(x.facts, y.facts) &&
      !disjoint((x.employer?.hiringNames ?? []).map(employerSpelling), (y.employer?.hiringNames ?? []).map(employerSpelling))));
}

function retainMissingFacts(old?: OpeningFacts, incoming?: OpeningFacts): OpeningFacts | undefined {
  if (!incoming) return old;
  if (!old) return incoming;
  // A retained legacy alias must not roll a refreshed extraction back to the
  // old parser. It can still supply constraints absent from the newer text.
  if (incoming.version < old.version) return retainMissingFacts(incoming, old);
  // Empty extraction means absent evidence, not an explicit withdrawal of a constraint.
  return { ...incoming,
    roleTokens: incoming.roleTokens.length ? incoming.roleTokens : old.roleTokens,
    degrees: incoming.degrees.length ? incoming.degrees : old.degrees,
    teams: incoming.teams.length ? incoming.teams : old.teams,
    technologies: incoming.technologies.length ? incoming.technologies : old.technologies,
    durationWeeks: incoming.durationWeeks?.length ? incoming.durationWeeks : old.durationWeeks,
  };
}

/** One current observation per source posting; preserve accepted aliases and missing facts. */
export function mergeIdentities(a: PostingIdentity[], b: PostingIdentity[]): PostingIdentity[] {
  const original = a;
  a = resolvePostingAliases(a, b);
  b = resolvePostingAliases(b, original);
  const byKey = new Map(a.map(x => [x.postingKey, x]));
  for (const x of b) {
    const old = byKey.get(x.postingKey);
    // Backfills and partial rediscovery must not overwrite known conflicting
    // opening evidence merely because a public posting key was reused.
    if (old && !identitiesAgree([old],[x])) continue;
    const current = old && (old.version ?? 0) > (x.version ?? 0) ? old : x;
    const previous = current === x ? old : x;
    byKey.set(x.postingKey, { ...previous, ...current,
      terms: current.terms.length ? current.terms : previous?.terms ?? [],
      openingKey: current.openingKey ?? previous?.openingKey,
      requisitionKey: current.requisitionKey ?? previous?.requisitionKey,
      requisitionReference: current.requisitionReference ?? previous?.requisitionReference,
      employer: current.employer ? { ...current.employer, hiringNames: current.employer.hiringNames ?? previous?.employer?.hiringNames } : previous?.employer,
      facts: retainMissingFacts(previous?.facts, current.facts),
    });
  }
  return [...byKey.values()];
}
function sharedKey(a: PostingIdentity[], b: PostingIdentity[], field: 'postingKey' | 'openingKey' | 'requisitionKey'): boolean {
  return a.some(x => x[field] && x[field] !== 'url:' && b.some(y => x[field] === y[field] &&
    (field !== 'postingKey' || !/^greenhouse:_:/.test(x.postingKey) ||
      (!!sourceUrlKey(x.sourceUrl) && sourceUrlKey(x.sourceUrl) === sourceUrlKey(y.sourceUrl)))));
}
function sameResolvedPosting(a: PostingIdentity[], b: PostingIdentity[]): boolean {
  return sharedKey(resolvePostingAliases(a, b), resolvePostingAliases(b, a), 'postingKey');
}
function sameEmployer(a: PostingIdentity[], b: PostingIdentity[]): boolean {
  return a.some(x => b.some(y => overlap(employerNames(x), employerNames(y)) > 0));
}
export function plausibleRole(a: string, b: string, leftLocations: string[] = [], rightLocations: string[] = []): boolean {
  const leftRole = roleSignature(a, leftLocations), rightRole = roleSignature(b, rightLocations);
  if (!leftRole || !rightRole) return true; // Generic titles cannot make competing openings disappear.
  const left = leftRole.split(' '), right = rightRole.split(' ');
  return left.every(w => right.includes(w)) || right.every(w => left.includes(w));
}
function plausible(a: PostingIdentity[], b: PostingIdentity[], leftLocations: string[] = [], rightLocations: string[] = []): boolean {
  return sameEmployer(a, b) && a.some(x => b.some(y => plausibleRole(x.title, y.title, leftLocations, rightLocations) && termsAgree(x.terms, y.terms)));
}
/** Refine qualifiers only within one already accepted opportunity. A separate generic
 * posting stays a competitor; Backend and Frontend can never refine each other. */
function qualifiedRoles(evidence: PostingIdentity[], locations: string[] = []): string[] {
  const roles = [...new Set(evidence.map(x => roleSignature(x.title, locations)).filter(Boolean))];
  return roles.filter(role => !roles.some(other => role !== other &&
    role.split(' ').every(word => other.split(' ').includes(word))));
}
function postingIssuer(x: PostingIdentity): string | undefined {
  const parts = x.postingKey.split(':');
  return parts[0] !== 'url' && parts[2] === 'post' ? parts.slice(0, 2).join(':') : undefined;
}
function separateAuthoritativePosts(a: PostingIdentity[], b: PostingIdentity[]): boolean {
  return a.some(x => postingIssuer(x) && b.some(y => postingIssuer(x) === postingIssuer(y) && x.postingKey !== y.postingKey &&
    !sharedKey([x], [y], 'openingKey') && !sharedKey([x], [y], 'requisitionKey')));
}
/** Multiple feed IDs are not competing openings when every pair is corroborated.
 * No transitive bridges: one unsupported pair keeps the ambiguity veto. */
function corroboratedCopies(rows: StoredInternship[]): boolean {
  return rows.every((a, n) => rows.slice(n + 1).every(b => {
    const left = a.identities ?? [], right = b.identities ?? [];
    if (!identitiesAgree(left, right, a.locations, b.locations) || separateAuthoritativePosts(left, right)) return false;
    if (['postingKey', 'openingKey', 'requisitionKey'].some(k => sharedKey(left, right, k as 'postingKey' | 'openingKey' | 'requisitionKey'))) return true;
    const roles = new Set([...qualifiedRoles(left, a.locations), ...qualifiedRoles(right, b.locations)]);
    return sameEmployer(left, right) && roles.size === 1 && !roles.has('') &&
      contentCorroborates(left, right);
  }));
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
      if (x.postingKey !== 'url:') add(`post:${x.postingKey}`);
      if (!x.postingKey.startsWith('url:') && sourceUrlKey(x.sourceUrl)) add(`source-url:${sourceUrlKey(x.sourceUrl)}`);
      if (x.openingKey) add(`opening:${x.openingKey}`);
      if (x.requisitionKey) add(`req:${x.requisitionKey}`);
      for (const name of employerNames(x)) {
        add(`employer:${name}`);
        const ref = requisitionReference(x);
        if (ref) add(`reference:${name}:${ref}`);
      }
    }
  }
  get(id: string): StoredInternship | undefined { return this.rows.get(id); }
  private candidates(keys: string[], incoming: StoredInternship): StoredInternship[] {
    const ids = new Set(keys.flatMap(k => [...this.keys.get(k) ?? []]));
    return [...ids].map(id => this.rows.get(id)!).filter(r => r.id !== incoming.id)
      .sort((a, b) => Number(a.archiveReason === 'duplicate') - Number(b.archiveReason === 'duplicate') || compareOpportunityAge(a, b));
  }
  find(incoming: StoredInternship): StoredInternship | undefined {
    const evidence = resolvePostingAliases([...this.rows.get(incoming.id)?.identities ?? [], ...incoming.identities ?? []]);
    // A reused native posting can represent different cohorts. Weak feed
    // labels cannot select between contradictory employer-owned observations.
    for (const x of evidence.filter(x => x.origin === 'feed' && postingIssuer(x))) {
      const boards = this.candidates([`post:${x.postingKey}`], incoming).flatMap(r => r.identities ?? [])
        .filter(y => y.origin === 'board' && y.postingKey === x.postingKey);
      if (!identitiesAgree(boards, boards)) return undefined;
    }
    const compatible = (r: StoredInternship) => identitiesAgree(evidence, r.identities ?? [], incoming.locations, r.locations);
    const exact = this.candidates(evidence.map(x => `post:${x.postingKey}`), incoming)
      .filter(r => sameResolvedPosting(evidence, r.identities ?? []) && compatible(r));
    if (exact.length) return exact[0];
    // An official board can use a custom careers URL which a feed only knows
    // as tenantless. The literal source-provided application URL is its alias.
    const urls = this.candidates(evidence.filter(x => !x.postingKey.startsWith('url:') && sourceUrlKey(x.sourceUrl))
      .map(x => `source-url:${sourceUrlKey(x.sourceUrl)}`), incoming)
      .filter(r => sameResolvedPosting(evidence, r.identities ?? []) && compatible(r));
    if (urls.length) return urls[0];
    const opening = this.candidates(evidence.flatMap(x => [x.openingKey ? `opening:${x.openingKey}` : '', x.requisitionKey ? `req:${x.requisitionKey}` : '']), incoming)
      .filter(compatible);
    if (opening.length) return opening[0];

    // A feed's literal requisition needs an observed employer AND a unique,
    // compatible native issuer. Never turn an unqualified number into a global key.
    const referenceKeys = evidence.flatMap(x => employerNames(x).flatMap(name => {
      const ref = requisitionReference(x);
      return ref ? [`reference:${name}:${ref}`] : [];
    }));
    const referenceRelated = (r: StoredInternship) => compatible(r) && evidence.some(x => (r.identities ?? []).some(y =>
        (x.requisitionKey || y.requisitionKey) && requisitionReference(x) &&
        requisitionReference(x) === requisitionReference(y) && sameEmployer([x], [y])));
    const references = this.candidates(referenceKeys, incoming).filter(referenceRelated);
    if (references.length) {
      const pendingReferences = this.pending.filter(r => r.id !== incoming.id && !r.archived && referenceRelated(r));
      const all = [...evidence, ...references.flatMap(r => r.identities ?? []), ...pendingReferences.flatMap(r => r.identities ?? [])];
      const issuers = new Set(all.filter(x => x.requisitionKey && evidence.some(y =>
        requisitionReference(x) === requisitionReference(y) && sameEmployer([x], [y])))
        .map(x => x.requisitionKey));
      if (issuers.size !== 1 || !identitiesAgree(all, all) ||
          !references.some(r => contentCorroborates(evidence, r.identities ?? []))) return undefined;
      return references[0];
    }

    // Plausibility is deliberately broader than positive evidence. Missing details cannot hide a competitor.
    const relatedRole = (r: StoredInternship) => sameEmployer(evidence, r.identities ?? []) &&
      evidence.some(x => (r.identities ?? []).some(y => plausibleRole(x.title, y.title, incoming.locations, r.locations)));
    const neighborhood = this.candidates(evidence.flatMap(x => employerNames(x).map(name => `employer:${name}`)), incoming)
      .filter(r => r.archiveReason !== 'duplicate' && relatedRole(r));
    const pendingRole = this.pending.filter(r => r.id !== incoming.id && !r.archived && relatedRole(r));
    const related = neighborhood.filter(r => plausible(evidence, r.identities ?? [], incoming.locations, r.locations));
    const pending = pendingRole.filter(r => plausible(evidence, r.identities ?? [], incoming.locations, r.locations));
    const corroborated = this.findCorroborated(incoming, evidence, neighborhood, pendingRole);
    if (corroborated) return corroborated.match;
    const all = resolvePostingAliases([...evidence, ...related.flatMap(r => r.identities ?? []), ...pending.flatMap(r => r.identities ?? [])], [], false);
    if (conflicts(all, all, 'openingKey') || conflicts(all, all, 'requisitionKey') || separateAuthoritativePosts(all, all)) return undefined;
    const groups = authoritativeGroups(all);
    if (groups > 1) return undefined;
    // Named teams are separate plausible openings even if the incoming title omits the team.
    const roles = new Set([qualifiedRoles(evidence, incoming.locations), ...related.map(r => qualifiedRoles(r.identities ?? [], r.locations)),
      ...pending.map(r => qualifiedRoles(r.identities ?? [], r.locations))].flat());
    if (roles.size > 1) return undefined;
    const provisional = new Map<string, StoredInternship>();
    for (const r of [...related, ...pending]) {
      const old = provisional.get(r.id);
      provisional.set(r.id, old ? { ...old, identities: mergeIdentities(old.identities ?? [], r.identities ?? []) } : r);
    }
    if (!groups && provisional.size > 1 && !corroboratedCopies([...provisional.values(), { ...incoming, identities: evidence }])) return undefined;
    const qualifiedRole = (r: StoredInternship) => qualifiedRoles(evidence, incoming.locations).some(role => qualifiedRoles(r.identities ?? [], r.locations).includes(role));
    // Old closed/rejected opportunities are remembered, but title + season alone
    // cannot make a genuinely new opening disappear into historical rows.
    const matches = related.filter(r => qualifiedRole(r) && compatible(r) &&
      (contentCorroborates(evidence, r.identities ?? []) || (!r.archived && sameExplicitTerm(evidence, r.identities ?? []))));
    return matches[0];
  }

  /** Find a fully corroborated role neighborhood, not a company-wide veto.
   * A decided-but-empty result is abstention and must not fall back to the
   * weaker role/season inference below. Pending rows participate in the proof,
   * but only an already stored row can be returned for consolidation. */
  private findCorroborated(incoming: StoredInternship, evidence: PostingIdentity[], related: StoredInternship[], pending: StoredInternship[]): { match?: StoredInternship } | undefined {
    const roles = qualifiedRoles(evidence, incoming.locations);
    if (roles.length !== 1 || !evidence.some(x => (x.facts?.roleTokens.length ?? 0) >= 12)) return undefined;
    const observations = new Map<string, StoredInternship>();
    for (const row of [...related, ...pending]) {
      const previous = observations.get(row.id);
      observations.set(row.id, previous ? { ...previous,
        identities: mergeIdentities(previous.identities ?? [], row.identities ?? []),
        locations: [...new Set([...previous.locations, ...row.locations])],
      } : row);
    }
    const agrees = (a: StoredInternship, b: StoredInternship) => identitiesAgree(a.identities ?? [], b.identities ?? [], a.locations, b.locations);
    const sameRole = (r: StoredInternship) => {
      const other = qualifiedRoles(r.identities ?? [], r.locations);
      return other.length === 1 && other[0] === roles[0];
    };
    const peers = [...observations.values()].filter(sameRole);
    const group: StoredInternship[] = [{ ...incoming, identities: evidence }];
    const remaining = new Set(peers);
    // Take the whole connected neighborhood before testing every pair. Choosing
    // only immediate neighbors would let verbose B bridge unsupported A and C.
    for (let n = 0; n < group.length; n++) {
      for (const row of remaining) if (agrees(group[n], row) && contentCorroborates(group[n].identities ?? [], row.identities ?? [])) {
        group.push(row);
        remaining.delete(row);
      }
    }
    if (group.length === 1) return undefined;
    if ([...remaining].some(r => !r.archived && group.some(member => agrees(member, r))) ||
        group.some(r => !identitiesAgree(r.identities ?? [], r.identities ?? [])) ||
        authoritativeGroups(resolvePostingAliases(group.flatMap(r => r.identities ?? []))) > 1 ||
        !corroboratedCopies(group)) return {};
    // A different qualified role is a real competitor when its content (or
    // explicit identity) connects it to this group, not merely its broad title.
    const competitors = [...observations.values()].filter(r => !sameRole(r));
    if (competitors.some(r => group.some(member => agrees(member, r) && (contentCorroborates(member.identities ?? [], r.identities ?? []) ||
      ['postingKey', 'openingKey', 'requisitionKey'].some(field => sharedKey(member.identities ?? [], r.identities ?? [], field as 'postingKey' | 'openingKey' | 'requisitionKey')))))) return {};
    const stored = group.flatMap(r => r.id !== incoming.id && this.rows.has(r.id) ? [this.rows.get(r.id)!] : []);
    return { match: stored.sort(compareOpportunityAge)[0] };
  }
}
