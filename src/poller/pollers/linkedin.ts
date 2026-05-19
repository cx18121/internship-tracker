import Parser from 'rss-parser';
import { Internship } from '../../lib/types';

const parser = new Parser({ timeout: 15000 });

// LinkedIn Jobs RSS feed for software engineering internships (public feed)
const RSS_FEEDS = [
  'https://www.linkedin.com/jobs/search/?keywords=software+engineer+intern&f_JT=I&f_WT=1%2C2%2C3&f_C=&geoId=103644278&trk=public_jobs_jobs-search-bar_search-submit&position=1&pageNum=0',
];

// LinkedIn doesn't provide a real RSS feed for jobs easily, so we use a workaround
// with their public job search. If that fails, we try an alternative approach.
const LINKEDIN_RSS_URL =
  'https://www.linkedin.com/jobs/search.rss?keywords=software+engineer+intern&location=United+States&f_JT=I&sortBy=DD';

function extractCompany(item: { [key: string]: any }): string {
  if (item['company']) return item['company'];
  if (item.contentSnippet) {
    const match = item.contentSnippet.match(/at ([A-Z][^.]+?)(?:\s+in|\s*$)/);
    if (match) return match[1].trim();
  }
  if (item.title) {
    const match = item.title.match(/at ([A-Z].+)$/);
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
