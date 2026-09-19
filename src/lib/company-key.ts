/**
 * One key per company across spellings: "Etched" and "Etched.ai", "1X" and
 * "1X Technologies", "Datology" and "DatologyAI". Used for company_profiles
 * (one judgment per company), company_facts lookups, and UI grouping.
 */
export function companyKey(name: string): string {
  return name
    .replace(/(?<=[a-z]{4,})AI$/, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(inc|llc|corp|corporation|co|ltd|limited|labs?|technologies|technology|ai|io|hq)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}
