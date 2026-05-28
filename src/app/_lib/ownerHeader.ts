// Client-side helper to inject the owner token on mutating fetches. The
// token is stored in `localStorage.ownerToken` (owner sets it once per
// device via devtools); server matches it against the OWNER_TOKEN env var.

export const OWNER_TOKEN_LS_KEY = "ownerToken";

export function ownerHeader(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const t = window.localStorage.getItem(OWNER_TOKEN_LS_KEY);
    return t ? { "x-owner-token": t } : {};
  } catch {
    return {};
  }
}
