import axios from 'axios';
import { Internship } from '../types.js';
import { discoverATSTarget, saveDiscoveredTargets } from '../utils/ats-discovery.js';

const README_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md';

// The README uses HTML table format: <tr><td>...</td></tr>
// Cell 0: Company — <strong><a href="...">Name</a></strong>
// Cell 1: Title (text)
// Cell 2: Location (text)
// Cell 3: Apply link — <a href="apply-url">...</a>
// Cell 4: Days posted

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(+code))
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'");
}

function stripHtml(html: string): string {
  // Replace <br> with newlines so multi-line content stays readable
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n');
  // Strip tags
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  // Decode HTML entities (e.g. &amp; &gt; &#x25B6; &#9654;)
  return decodeHtmlEntities(stripped).trim();
}

/**
 * Parse a multi-location <details><summary> cell.
 * Input e.g.: <details><summary><strong>6 locations</strong></summary>California<br>SF<br>Arizona...</details>
 * Returns { count, locations[] } or null if not a multi-location cell.
 */
function parseMultiLocation(cellHtml: string): { count: number; locations: string[] } | null {
  const countMatch = cellHtml.match(/<strong>(\d+)\s+locations?<\/strong>/i);
  if (!countMatch) return null;
  const count = +countMatch[1];
  // Extract text content after the closing </summary>, splitting on <br>
  const afterSummary = cellHtml.replace(/<\/summary>/i, '\n').replace(/<[^>]+>/g, '\n');
  const locations = afterSummary.split('\n').map(s => s.trim()).filter(s => s && !/^\d+$/.test(s) && !s.toLowerCase().includes('location'));
  return { count, locations };
}

function extractHref(html: string): string {
  // Find the first job application link (greenhouse, lever, workday, etc.)
  // Avoid simplify.jobs links as primary; prefer direct apply links
  const hrefMatches = [...html.matchAll(/href="([^"]+)"/g)];
  for (const [, href] of hrefMatches) {
    if (
      href.includes('greenhouse.io') ||
      href.includes('lever.co') ||
      href.includes('workday') ||
      href.includes('myworkdayjobs') ||
      href.includes('careers') ||
      href.includes('jobs') ||
      href.includes('apply') ||
      href.includes('smartrecruiters') ||
      href.includes('ashbyhq') ||
      href.includes('icims')
    ) {
      return href;
    }
  }
  // Fallback to simplify.jobs
  for (const [, href] of hrefMatches) {
    if (href.includes('simplify.jobs')) return href;
  }
  return hrefMatches[0]?.[1] || '';
}

function parseRows(html: string): { company: string; title: string; location: string; link: string; multiLocation?: string[] }[] {
  const results = [];

  // Match all <tr> blocks
  const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
  let trMatch: RegExpExecArray | null;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1];

    // Extract <td> cells
    const cells: string[] = [];
    const tdRegex = /<td>([\s\S]*?)<\/td>/g;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      cells.push(tdMatch[1].trim());
    }

    if (cells.length < 4) continue;

    const company = stripHtml(cells[0]);
    const title = stripHtml(cells[1]);
    const locationRaw = cells[2];

    // Detect multi-location cells (contain <details>)
    const multiLoc = parseMultiLocation(locationRaw);
    const location = stripHtml(locationRaw);
    const link = extractHref(cells[3]);

    if (company === '↳') continue; // continuation row for multi-location, skip
    if (!company || !title || company.toLowerCase() === 'company') continue;

    const row = { company, title, location, link };
    if (multiLoc) {
      (row as any).multiLocation = multiLoc.locations;
    }
    results.push(row);
  }

  return results;
}

export async function pollGitHub(): Promise<Partial<Internship>[]> {
  const response = await axios.get<string>(README_URL, { responseType: 'text', timeout: 15000 });
  const readme = response.data;

  const rows = parseRows(readme);
  const results: Partial<Internship>[] = rows.map(row => {
    const atsTarget = discoverATSTarget(row.link, row.company);
    const entry: Partial<Internship> = {
      title: row.title,
      company: row.company,
      location: row.location,
      link: row.link,
      source: 'SimplifyJobs',
      atsSource: atsTarget ? atsTarget.ats : 'unknown',
      postedAt: new Date().toISOString(),
      seenAt: new Date().toISOString(),
      applied: false,
    };
    if (row.multiLocation && row.multiLocation.length > 0) {
      entry.multiLocation = row.multiLocation;
    }
    return entry;
  });

  // Auto-discover new ATS targets from direct links in SimplifyJobs
  const discovered = rows
    .map(row => discoverATSTarget(row.link, row.company))
    .filter((t): t is NonNullable<typeof t> => t !== null);
  const added = saveDiscoveredTargets(discovered);
  if (added > 0) {
    console.log(`[github poller] Auto-discovered ${added} new ATS target(s)`);
  }

  console.log(`[github poller] Fetched ${results.length} postings from SimplifyJobs`);
  return results;
}
