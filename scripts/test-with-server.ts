// Runs the test suite against a freshly-started dev server, then shuts it
// down. Resolves the "6 live API tests fail because no server is running"
// gap from `npm test` without making the test file itself responsible for
// process management.
//
// Flow:
//   1. Spawn `next dev -p <PORT>` in the background, suppressing its output
//      unless DEBUG_SERVER=1.
//   2. Poll /api/internships/stats until it 200s (or timeout).
//   3. Run `npx tsx src/poller/test.ts` to completion.
//   4. SIGTERM the dev server; SIGKILL after 5s if it ignores.
//   5. Exit with the test suite's exit code.
//
// Usage: npx tsx scripts/test-with-server.ts
//        DEBUG_SERVER=1 npx tsx scripts/test-with-server.ts   (stream dev logs)

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

const PORT = process.env.PORT || '3001';
const STATS_URL = `http://localhost:${PORT}/api/internships/stats`;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const DEBUG = process.env.DEBUG_SERVER === '1';

function log(msg: string): void {
  console.log(`[test-with-server] ${msg}`);
}

async function waitForReady(): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    try {
      const r = await fetch(STATS_URL);
      if (r.ok) return true;
    } catch {
      // ECONNREFUSED until next is listening — keep polling
    }
    await new Promise((res) => setTimeout(res, READY_POLL_MS));
  }
  return false;
}

async function shutdown(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      log('Server ignored SIGTERM after 5s, sending SIGKILL');
      server.kill('SIGKILL');
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
    server.on('exit', () => { clearTimeout(t); resolve(); });
  });
}

(async () => {
  log(`Starting dev server on port ${PORT}…`);
  const server = spawn('npx', ['next', 'dev', '-p', PORT], {
    cwd: process.cwd(),
    env: { ...process.env, PORT },
    stdio: DEBUG ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  // Drain pipes so the child doesn't block on a full buffer. Surface stderr
  // for crashes so we know why the server failed to start.
  if (!DEBUG) {
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  }

  server.on('error', (err) => {
    log(`Spawn error: ${err.message}`);
    process.exit(1);
  });

  // Ensure server is reaped on Ctrl-C
  const onSignal = async () => { await shutdown(server); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  log('Waiting for /api/internships/stats to respond…');
  const ready = await waitForReady();
  if (!ready) {
    log(`Server didn't become ready within ${READY_TIMEOUT_MS}ms — aborting.`);
    await shutdown(server);
    process.exit(2);
  }
  log('Server ready. Running tests…\n');

  const tester = spawn('npx', ['tsx', path.join('src', 'poller', 'test.ts')], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });

  const testExitCode = await new Promise<number>((resolve) => {
    tester.on('exit', (code) => resolve(code ?? 1));
  });

  log(`\nTests exited ${testExitCode}. Shutting down server…`);
  await shutdown(server);
  process.exit(testExitCode);
})();
