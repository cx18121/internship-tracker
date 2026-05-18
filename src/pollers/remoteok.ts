import Parser from 'rss-parser';
import { Internship } from '../types.js';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
  customFields: { item: ['company', 'location', 'tags'] },
});

// RemoteOK RSS feeds — intern/developer focused
const FEEDS = [
  'https://remoteok.com/remote-intern-jobs.rss',
  'https://remoteok.com/remote-intern+dev-jobs.rss',
  'https://remoteok.com/remote-intern+engineer-jobs.rss',
];

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function pollRemoteOK(): Promise<Partial<Internship>[]> {
  const seen = new Set<string>();
  const results: Partial<Internship>[] = [];

  for (const url of FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items || []) {
        const title = (item.title || '').trim();
        const link = item.link || item.guid || '';
        const key = `${title}|${link}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const description = item.content || item.contentSnippet || '';
        const company = (item as any).company || item.creator || 'Unknown';
        const location = (item as any).location || 'Remote';

        results.push({
          title,
          company,
          location,
          description: stripHtml(description).slice(0, 2000),
          link,
          source: 'RemoteOK',
          postedAt: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
          seenAt: new Date().toISOString(),
          applied: false,
        });
      }
    } catch (err: any) {
      console.warn(`[remoteok poller] Failed to fetch ${url}: ${err.message}`);
    }
  }

  console.log(`[remoteok poller] Fetched ${results.length} postings`);
  return results;
}
