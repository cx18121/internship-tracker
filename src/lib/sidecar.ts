import * as fs from 'fs';
import * as path from 'path';

/**
 * Tiny load/save helper for JSON sidecar files under `data/`. Replaces ~7
 * inline copies of `try { JSON.parse(fs.readFileSync(...)) } catch { ... }`
 * scattered across the poller. Two responsibilities:
 *
 *   1. `load()` reads the file and returns the parsed value, or `defaults`
 *      if the file is missing or malformed. Never throws.
 *   2. `save(data)` writes pretty-printed JSON, creating the parent
 *      directory if it doesn't exist (so first-run on a clean volume
 *      doesn't ENOENT).
 *
 * Defaults are spread under the parsed payload — same shallow-merge
 * semantics as the previous bespoke loaders, so a sidecar written before
 * a new field was added still hydrates that field on next read.
 */
export function jsonStore<T extends object>(
  filename: string,
  defaults: T,
): { load(): T; save(data: T): void } {
  // Resolve once at module load. DATA_DIR env override is the test-isolation
  // seam — tests point it at a tmpdir so they don't trample real sidecars.
  const baseDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
  const filePath = path.isAbsolute(filename) ? filename : path.join(baseDir, filename);

  return {
    load(): T {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return { ...defaults, ...parsed };
      } catch {
        return { ...defaults };
      }
    },
    save(data: T): void {
      // Best-effort: a write failure logs but doesn't throw. The pre-refactor
      // helpers (saveSimplifyCache, saveHistory in linkedin-revalidate) wrapped
      // writeFileSync in try/catch so a transient FS hiccup couldn't break the
      // calling cycle after the real work (DB archive, list fetch) had already
      // succeeded. Preserve that contract here so every consumer gets the
      // same recoverable semantics.
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[sidecar] Failed to write ${filePath}: ${msg}`);
      }
    },
  };
}
