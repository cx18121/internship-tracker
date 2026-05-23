// HTML-to-plain-text helpers used by every poller that pulls a description
// from an upstream ATS (Greenhouse/Lever/Ashby/Workday/SmartRecruiters) or
// from a scraped README cell. Two divergent copies lived in github.ts and
// ats.ts before this; the github copy handled numeric entities but lost the
// whitespace-collapse, the ats copy collapsed whitespace but ignored numeric
// entities. Frontends render `description` with `whitespace-pre-wrap`, so
// preserving newlines is the right default — callers that want a single
// line can post-process. Tags become a single space (safer than empty:
// `<span>a</span><span>b</span>` stays "a b" instead of collapsing to "ab").

/** Decode HTML entities — named, decimal numeric, and hex numeric. */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(+code))
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Strip HTML to plain text. Preserves `<br>` as `\n` so multi-paragraph
 * descriptions stay readable in the UI's `whitespace-pre-wrap` renderer.
 * Empty / nullish input returns `''`.
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(stripped).trim();
}
