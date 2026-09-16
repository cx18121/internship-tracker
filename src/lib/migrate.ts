import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPool } from './db';

/** Apply every migrations/*.sql in order. Each file is idempotent. */
export async function runMigrations(): Promise<void> {
  const dir = path.join(process.cwd(), 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await getPool().query(fs.readFileSync(path.join(dir, file), 'utf-8'));
  }
}
