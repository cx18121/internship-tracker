/**
 * One key per company across spellings: "Etched" and "Etched.ai", "1X" and
 * "1X Technologies", "JP Morgan Chase" and "JPMorganChase". Used for
 * company_profiles (one judgment per company) and company_facts lookups.
 */
export function companyKey(name: string): string {
  return name.toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(inc|llc|corp|corporation|co|ltd|limited|labs?|technologies|technology|ai|io|hq)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}
