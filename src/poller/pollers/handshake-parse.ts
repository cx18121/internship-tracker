// Pure derivation of Handshake job-card fields from RAW scraped signals.
// Kept browser-free and side-effect-free so it is unit-testable; the
// scraper (handshake.ts) collects raw strings in page.evaluate and calls
// these in Node. Anchored to the card structure verified via live recon
// on 2026-06-04:
//   logoAlt   = img[alt]  (clean company; ~12% of cards have no logo)
//   ariaLabel = "{Company} {Role} {Pay|Unpaid} · {Type} · {Dates} {Location} {time}"
//   footer    = "[Promoted∙]{Location}∙{time-ago}"   (∙ = U+2219)

const PAY_TOKEN_RE = /\$\s*[\d,]+(?:\.\d+)?(?:\s*[-–—to]+\s*\$?\s*[\d,]+(?:\.\d+)?)?\s*[kK]?\s*\/?\s*(?:hr|hour|hourly|yr|year|mo|month|K\/yr|K\/mo)?/;
const TIME_AGO_RE = /^\s*(?:new|promoted|\d+\s*(?:h|hr|hrs|hour|hours|d|day|days|wk|wks|week|weeks|mo|month|months|yr|yrs|year|years)\s+ago)\s*$/i;

/** Company from the logo alt. Returns null when absent — the caller is
 *  responsible for the detail-page fallback and, failing that, dropping the
 *  card (we never store a guessed company). */
export function deriveCompany(logoAlt: string, _ariaLabel: string): string | null {
  const c = (logoAlt || '').trim();
  return c.length > 0 ? c : null;
}

/** Split the aria-label into role + comp token. Strips the known company
 *  prefix, then cuts at the first of: a $-pay token, the word "Unpaid"
 *  (or "Unspecified"), or " · " (the type separator). */
export function deriveRoleAndComp(company: string, ariaLabel: string): { role: string; comp: string } {
  let rest = (ariaLabel || '').trim();
  const co = (company || '').trim();
  if (co && rest.toLowerCase().startsWith(co.toLowerCase())) {
    const afterCo = rest.slice(co.length);
    // Only strip when the prefix ends on a word boundary — guards against a
    // logo-alt that is a mid-word prefix of the aria-label company, which
    // would otherwise leave a fragment glued to the role.
    if (afterCo === '' || /^\s/.test(afterCo)) {
      rest = afterCo.trim();
    }
  }
  const payMatch = rest.match(/\$\s*[\d,]/);
  const unpaidMatch = rest.match(/\b(Unpaid|Unspecified)\b/i);
  const sepIdx = rest.indexOf(' · ');
  const candidates = [
    payMatch ? payMatch.index ?? -1 : -1,
    unpaidMatch ? unpaidMatch.index ?? -1 : -1,
    sepIdx,
  ].filter((i) => i >= 0);
  const cut = candidates.length ? Math.min(...candidates) : rest.length;

  const role = rest.slice(0, cut).trim();
  const after = rest.slice(cut).trim();
  const beforeSep = after.split(' · ')[0].trim();
  const payInComp = beforeSep.match(PAY_TOKEN_RE);
  const comp = payInComp && /\$/.test(beforeSep) ? payInComp[0].trim() : '';
  return { role, comp };
}

/** Location from the footer hook: split on the bullet separator, drop a
 *  leading "Promoted" and the trailing "<n><unit> ago"/"New", keep the rest.
 *  Splits on both U+2219 (∙, the observed separator) and U+00B7 (·) so a
 *  card that renders the middle-dot variant still parses instead of dumping
 *  the whole footer into the location. */
export function deriveLocation(footerText: string): string {
  const parts = (footerText || '')
    .split(/[∙·]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !TIME_AGO_RE.test(s));
  return parts.join(' ').trim();
}
