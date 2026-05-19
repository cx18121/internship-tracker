export const LS_DATES_KEY = "internship-applied-dates";
export const LS_NOTES_KEY = "internship-notes";

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, val: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}
