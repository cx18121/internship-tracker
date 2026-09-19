/**
 * Stable identity of a posting across links to the same job. The same Ashby
 * or Greenhouse job reaches us from the board, SimplifyJobs, and LinkedIn
 * with different casing, embed flags, or /application suffixes; two rows
 * with the same jobKey are one posting. Unknown hosts fall back to the URL
 * without query, hash, or trailing slash.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(`jobs\\.ashbyhq\\.com/[^/]+/(${UUID})`), 'ashby'],
  [new RegExp(`jobs\\.lever\\.co/[^/]+/(${UUID})`), 'lever'],
  [/greenhouse\.io\/[^/]+\/jobs\/(\d+)/, 'greenhouse'],
  [/[?&]gh_jid=(\d+)/, 'greenhouse'],
  [/myworkday(?:jobs|site)\.com\/.*?\/job\/.*?_([A-Za-z]*\d[\w-]*)(?:[/?#]|$)/, 'workday'],
  [/careers\.smartrecruiters\.com\/[^/]+\/(\d+)/, 'smartrecruiters'],
  [new RegExp(`ats\\.rippling\\.com/[^/]+/jobs/(${UUID})`), 'rippling'],
  [/apply\.workable\.com\/[^/]+\/j\/([A-Za-z0-9]+)/, 'workable'],
  [/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d+)/, 'linkedin'],
  [new RegExp(`simplify\\.jobs/p/(${UUID})`), 'simplify'],
];

export function jobKey(link: string): string {
  const lower = link.toLowerCase();
  for (const [re, ats] of PATTERNS) {
    const m = lower.match(re);
    if (m) return `${ats}:${m[1]}`;
  }
  return lower.replace(/[?#].*$/, '').replace(/\/application$/, '').replace(/\/+$/, '');
}
