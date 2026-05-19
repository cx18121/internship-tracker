#!/usr/bin/env node
/**
 * Process supervisor — replaces `concurrently --kill-others-on-fail` with
 * Node's own child_process + signal handling. Node's signal/exit semantics
 * are well-defined (unlike POSIX sh trap edge cases), so SIGTERM-induced
 * shutdowns reliably exit 0 and Railway stops emailing "Deploy Crashed!"
 * for every deploy roll.
 *
 * Behaviour:
 *   - Spawns next + tsx as children with stdio piped through a [web]/[poll]
 *     prefix (matches the old concurrently log format).
 *   - On SIGTERM/SIGINT: forwards to both children, waits for both to exit,
 *     then process.exit(0) regardless of children's individual codes
 *     (signal-induced exits like Next.js's 143 are translated to 0).
 *   - On a child exiting non-zero WITHOUT a signal having been received first:
 *     treat as crash → kill the other child, propagate the failure exit code
 *     so Railway's restart-on-failure logic still kicks in for real crashes.
 *   - 30s SIGKILL fallback if a child ignores SIGTERM.
 */

const { spawn } = require('child_process');

const PORT = process.env.PORT || '3000';

const COLORS = {
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  reset: '\x1b[0m',
};

const children = [
  {
    name: 'web',
    color: COLORS.cyan,
    cmd: './node_modules/.bin/next',
    args: ['start', '-p', PORT, '-H', '0.0.0.0'],
  },
  {
    name: 'poll',
    color: COLORS.magenta,
    cmd: './node_modules/.bin/tsx',
    args: ['src/poller/index.ts'],
  },
];

let shuttingDown = false;
let exited = false;
let exitedCount = 0;
let firstFailureCode = 0;

function logLine(child, line, isErr) {
  if (!line) return;
  const prefix = `${child.color}[${child.name}]${COLORS.reset}`;
  const out = isErr ? process.stderr : process.stdout;
  out.write(`${prefix} ${line}\n`);
}

function pipePrefixed(stream, child, isErr) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      logLine(child, buf.slice(0, idx), isErr);
      buf = buf.slice(idx + 1);
    }
  });
  stream.on('end', () => {
    if (buf) logLine(child, buf, isErr);
  });
}

function killOthers(except, signal) {
  for (const c of children) {
    if (c === except) continue;
    if (c.proc && c.proc.exitCode === null && !c.killed) {
      logLine(c, `sending ${signal} (kill-others-on-fail)`);
      c.killed = true;
      c.proc.kill(signal);
    }
  }
}

function onChildExit(child, code, signal) {
  child.exited = true;
  exitedCount++;
  logLine(child, `exited (code=${code}, signal=${signal})`);

  // If a child failed without a parent-level shutdown signal first, treat as
  // crash: kill the other and remember the code so we exit non-zero at the end.
  if (!shuttingDown && code !== 0 && code !== null) {
    if (firstFailureCode === 0) firstFailureCode = code;
    killOthers(child, 'SIGTERM');
  }

  if (exitedCount === children.length && !exited) {
    exited = true;
    if (shuttingDown) {
      // Graceful shutdown — signal-induced exits (Next.js's 143, anything
      // killed via SIGTERM/SIGKILL by us) all become 0.
      console.log('[supervisor] all children exited, shutting down clean (0)');
      process.exit(0);
    }
    console.log(`[supervisor] all children exited, propagating failure code ${firstFailureCode}`);
    process.exit(firstFailureCode);
  }
}

function spawnChild(child) {
  const proc = spawn(child.cmd, child.args, {
    cwd: '/app',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.proc = proc;
  pipePrefixed(proc.stdout, child, false);
  pipePrefixed(proc.stderr, child, true);
  proc.on('exit', (code, signal) => onChildExit(child, code, signal));
  proc.on('error', (err) => {
    console.error(`[supervisor] ${child.name} spawn error:`, err.message);
    if (firstFailureCode === 0) firstFailureCode = 1;
    onChildExit(child, 1, null);
  });
}

function handleSignal(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[supervisor] received ${sig}, forwarding to children`);
  for (const c of children) {
    if (c.proc && c.proc.exitCode === null) {
      c.proc.kill(sig);
    }
  }
  // Safety net: SIGKILL anything still alive after 30s so we don't hang past
  // Railway's grace period.
  setTimeout(() => {
    for (const c of children) {
      if (c.proc && c.proc.exitCode === null) {
        console.error(`[supervisor] ${c.name} didn't exit in 30s, sending SIGKILL`);
        c.proc.kill('SIGKILL');
      }
    }
  }, 30000).unref();
}

process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));

console.log(`[supervisor] starting web (port ${PORT}) + poll`);
for (const c of children) spawnChild(c);
