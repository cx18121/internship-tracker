import { Pool, types } from 'pg';

// Return NUMERIC (OID 1700) as a JS number instead of a string. We use NUMERIC
// only for salary fields where float precision is fine; default-string would
// force coercion at every read site.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
  });
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
