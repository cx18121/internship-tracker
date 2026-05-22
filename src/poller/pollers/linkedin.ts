import Parser from 'rss-parser';
import { Internship } from '../../lib/types';

const parser = new Parser({ timeout: 15000 });

// LinkedIn doesn't provide a real RSS feed for jobs easily, so we use a workaround
// via their public job-search .rss endpoint.
const LINKEDIN_RSS_URL =
  'https://www.linkedin.com/jobs/search.rss?keywords=software+engineer+intern&location=United+States&f_JT=I&sortBy=DD';

function extractCompany(item: { [key: string]: any }): string {
  if (item['company']) return item['company'];
  if (item.contentSnippet) {
    const match = item.contentSnippet.match(/at ([A-Z][^.]+?)(?:\s+in|\s*$)/);
    if (match) return match[1].trim();
  }
  if (item.title) {
    // Stop-token regex: capture up to " in", ",", or end. The old `(.+)$`
    // was greedy and slurped the location into the company name
    // (e.g. "Stripe in San Francisco, CA" instead of "Stripe").
    const match = item.title.match(/\bat\s+([A-Z][^.|·]+?)(?:\s+(?:in|,)|$)/);
    if (match) return match[1].trim();
  }
  return 'Unknown';
}

function extractLocation(item: { [key: string]: any }): string {
  if (item.contentSnippet) {
    const match = item.contentSnippet.match(/(?:in|location:)\s+([^.]+?)(?:\.|$)/i);
    if (match) return match[1].trim();
  }
  return 'United States';
}

export async function pollLinkedIn(): Promise<Partial<Internship>[]> {
  const results: Partial<Internship>[] = [];

  try {
    const feed = await parser.parseURL(LINKEDIN_RSS_URL);
    for (const item of feed.items || []) {
      const title = item.title || '';
      const titleLower = title.toLowerCase();

      // Filter for intern + software engineer relevance
      if (!titleLower.includes('intern') && !titleLower.includes('internship')) continue;

      results.push({
        title,
        company: extractCompany(item),
        location: extractLocation(item),
        link: item.link || item.guid || '',
        source: 'LinkedIn',
        postedAt: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
        seenAt: new Date().toISOString(),
        applied: false,
      });
    }
    console.log(`[linkedin poller] Fetched ${results.length} postings from LinkedIn RSS`);
  } catch (err: any) {
    console.warn(`[linkedin poller] Failed to fetch LinkedIn RSS: ${err.message}`);
    // LinkedIn often blocks RSS — this is expected
  }

  return results;
}
