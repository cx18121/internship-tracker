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
    // Without these, a stuck pool acquire or a hung query waits FOREVER — and if
    // it happens inside the store's withLock mutex (store.ts), every subsequent
    // poll cycle's write deadlocks behind it. Bound all three so a stall
    // surfaces as a thrown error the cycle can recover from, not a silent hang.
    // Limits sit well above any real query here (largest is a net-new batch
    // insert, well under a second in practice).
    connectionTimeoutMillis: 10000, // fail an acquire after 10s instead of hanging
    statement_timeout: 60000,       // server cancels any single query running >60s
    query_timeout: 60000,           // client-side guard for the same
  });
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
