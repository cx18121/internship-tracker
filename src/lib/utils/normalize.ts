/**
 * Strips UTM/analytics tracking parameters from a URL.
 * Used to normalize links before hashing for deduplication.
 *
 * Handles:
 *   - Query params: utm_source, utm_medium, utm_campaign, utm_term, utm_content,
 *     ref, referrer, ref_, affiliated, affiliate, partner, source
 *   - Fragment identifiers used for tracking: #ref=, #utm-
 *   - LinkedIn's trk= parameters
 *   - Glassdoor's iorq= redirect param
 *
 * NOTE: Indeed's `jk=` is the actual job identifier, not tracking — keep it.
 * Stripping it collapsed every Indeed posting to the same `viewjob` URL and
 * destroyed dedup keys for that source.
 */
export function stripUtm(url: string): string {
  if (!url) return url;

  try {
    const parsed = new URL(url);

    // Strip known tracking query params
    const TRACKING_PARAMS = new Set([
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'utm_id', 'utm_cid', 'utm_reader', 'utm_viz_id',
      'ref', 'referrer', 'ref_', 'affiliated', 'affiliate', 'partner',
      'source', 'trk', 'trkInfo', 'trkCampaign',
      'ic',       // LinkedIn tracking
      'iorq',     // Glassdoor redirect
      'vnp', 'vnp_', // generic tracking
    ]);

    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }

    // Strip tracking-only hash fragments
    const hash = parsed.hash.replace(/#*(utm-|ref=|trk=).*/i, '');
    parsed.hash = hash.startsWith('#') ? hash : '';

    // Reconstruct — drop ? if no query params remain
    const result = parsed.toString().replace(/\?$/, '');
    return result;
  } catch {
    // Malformed URL — try to strip obvious tracking patterns via regex fallback
    return url
      .replace(/[?#]&*(utm_|ref|trk|affiliated|affiliate|partner|source)=[^&#]*/gi, '')
      .replace(/\?$/, '');
  }
}
