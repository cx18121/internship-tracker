import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Internship } from '../../lib/types';
import { isInternTitle } from './ats';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'inhouse-targets.json');
const REQUEST_TIMEOUT = 15_000;

interface InhouseTarget {
  name: string;
  url: string;
  selectors?: {
    jobItem?: string;
    title?: string;
    linkAttr?: string;
  };
}

interface JsonLdJobPosting {
  '@type': string;
  title?: string;
  url?: string;
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string } } | Array<{ address?: { addressLocality?: string; addressRegion?: string } }>;
  datePosted?: string;
  hiringOrganization?: { name?: string };
}

function extractJsonLd(html: string): JsonLdJobPosting[] {
  const results: JsonLdJobPosting[] = [];
  const pattern = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const items: any[] = Array.isArray(parsed)
        ? parsed
        : parsed['@graph']
          ? parsed['@graph']
          : [parsed];
      for (const item of items) {
        if (item['@type'] === 'JobPosting') results.push(item);
      }
    } catch {
      // ignore parse errors
    }
  }
  return results;
}

function locationFromJsonLd(posting: JsonLdJobPosting): string {
  const loc = Array.isArray(posting.jobLocation)
    ? posting.jobLocation[0]
    : posting.jobLocation;
  if (!loc?.address) return 'United States';
  const { addressLocality, addressRegion } = loc.address;
  return [addressLocality, addressRegion].filter(Boolean).join(', ') || 'United States';
}

export async function pollInhouse(): Promise<Partial<Internship>[]> {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.warn('[inhouse] No config at', CONFIG_PATH);
    return [];
  }

  const targets: InhouseTarget[] = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const now = new Date().toISOString();
  const results: Partial<Internship>[] = [];

  for (const target of targets) {
    try {
      const { data: html } = await axios.get(target.url, {
        timeout: REQUEST_TIMEOUT,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; internship-tracker/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        responseType: 'text',
      });

      // Strategy 1: JSON-LD JobPosting blocks
      const jsonldJobs = extractJsonLd(html as string);
      if (jsonldJobs.length > 0) {
        const filtered = jsonldJobs
          .filter((j) => isInternTitle(j.title || ''))
          .map((j) => ({
            title: j.title || '',
            company: j.hiringOrganization?.name || target.name,
            location: locationFromJsonLd(j),
            link: j.url || target.url,
            source: 'Inhouse',
            postedAt: j.datePosted || now,
            seenAt: now,
            applied: false,
          }));
        if (filtered.length > 0) {
          console.log(`[inhouse] ${target.name} (JSON-LD): ${filtered.length} internships`);
          results.push(...filtered);
          continue;
        }
      }

      // Strategy 2: regex scrape for anchor tags containing intern-title text
      // Match <a href="...">...intern...</a> patterns
      const anchorPattern = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const pageJobs: Partial<Internship>[] = [];
      const seen = new Set<string>();
      let am: RegExpExecArray | null;
      while ((am = anchorPattern.exec(html as string)) !== null) {
        const href = am[1];
        const raw = am[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        // Decode common HTML entities and strip leading icon-font artifacts
        const text = raw
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#\d+;/g, '')
          .replace(/^icon\s*/i, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!isInternTitle(text)) continue;
        if (seen.has(text + href)) continue;
        seen.add(text + href);
        const link = href.startsWith('http')
          ? href
          : new URL(href, target.url).href;
        pageJobs.push({
          title: text,
          company: target.name,
          location: 'United States',
          link,
          source: 'Inhouse',
          postedAt: now,
          seenAt: now,
          applied: false,
        });
      }

      if (pageJobs.length > 0) {
        console.log(`[inhouse] ${target.name} (regex): ${pageJobs.length} internships`);
        results.push(...pageJobs);
      } else {
        console.log(`[inhouse] ${target.name}: 0 internships found`);
      }
    } catch (e: any) {
      const msg = e?.response?.status ? `HTTP ${e.response.status}` : e.message;
      console.warn(`[inhouse] ${target.name}: ${msg}`);
    }
  }

  console.log(`[inhouse] Total: ${results.length} internships from ${targets.length} targets`);
  return results;
}
