/**
 * One key per company across spellings: "Etched" and "Etched.ai", "1X" and
 * "1X Technologies", "Datology" and "DatologyAI". Used for company_profiles
 * (one judgment per company), company_facts lookups, and UI grouping.
 */
export function companyKey(name: string): string {
  return name
    .normalize('NFC')
    .replace(/(?<=[a-z]{4,})AI$/, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(inc|llc|corp|corporation|co|ltd|limited|labs?|technologies|technology|ai|io|hq)\b/g, ' ')
    // Non-Latin names are identities too. Keep marks for scripts that use
    // combining characters; punctuation-only names intentionally have no key.
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '')
    // Lowercasing and removing punctuation can expose new combining sequences.
    .normalize('NFC');
}
