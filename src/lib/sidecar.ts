import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Load/save for poller-only JSON caches under data/ (DATA_DIR overrides for
 * tests). `load()` returns `defaults` merged under the file's contents and
 * never throws; `save()` is best-effort and returns whether the write landed.
 * Shared poller/web state belongs in app-state.ts (Postgres), not here.
 */
export function jsonStore<T extends object>(filename: string, defaults: T): { load(): T; save(data: T): boolean } {
  const baseDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
  const filePath = path.isAbsolute(filename) ? filename : path.join(baseDir, filename);
  return {
    load(): T {
      try {
        return { ...defaults, ...JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
      } catch {
        return { ...defaults };
      }
    },
    save(data: T): boolean {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
      } catch (e) {
        console.warn(`[sidecar] Failed to write ${filePath}: ${e instanceof Error ? e.message : e}`);
        return false;
      }
    },
  };
}
