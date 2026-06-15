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

let shuttingDown = false; // graceful shutdown (SIGTERM) OR escalation in progress
let escalating = false;   // a child crash-looped — bring the whole container down
let exited = false;
let firstFailureCode = 0;

// A crashed child is restarted IN PLACE rather than taking the whole container
// down with it, so the poller tripping its watchdog (or any one component
// crashing) doesn't kill the web server or burn Railway's container-restart
// budget. We only escalate to a full-container exit if a child crash-loops
// (too many failures faster than HEALTHY_MS apart).
const MAX_RESTARTS = parseInt(process.env.SUPERVISOR_MAX_RESTARTS || '5', 10);
const HEALTHY_MS = parseInt(process.env.SUPERVISOR_HEALTHY_MS || '60000', 10);
const RESTART_BACKOFF_MS = [0, 1000, 5000, 15000, 30000, 60000];
function backoffFor(n) {
  return RESTART_BACKOFF_MS[Math.min(n, RESTART_BACKOFF_MS.length - 1)];
}

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

// Last resort: a child crash-looped. Bring the whole container down so Railway's
// ON_FAILURE policy restarts it from a clean slate.
function escalate() {
  if (escalating) return;
  escalating = true;
  shuttingDown = true; // cancels any pending in-place respawns
  for (const c of children) {
    if (c.proc && c.proc.exitCode === null) {
      logLine(c, 'sending SIGTERM (escalating to full container restart)');
      c.proc.kill('SIGTERM');
    }
  }
  // If everything is already down, exit now; otherwise wait for the SIGTERM'd
  // children, with a hard fallback if one ignores SIGTERM.
  if (children.every((c) => c.exited)) {
    process.exit(firstFailureCode || 1);
  }
  setTimeout(() => process.exit(firstFailureCode || 1), 30000).unref();
}

function onChildExit(child, code, signal) {
  child.exited = true;
  logLine(child, `exited (code=${code}, signal=${signal})`);

  // During a graceful shutdown or an escalation, a child exit is terminal. Once
  // every child is down, exit: 0 for a clean shutdown, the failure code for an
  // escalation.
  if (shuttingDown) {
    if (children.every((c) => c.exited) && !exited) {
      exited = true;
      if (escalating) {
        console.log(`[supervisor] all children down after escalation, exiting ${firstFailureCode || 1}`);
        process.exit(firstFailureCode || 1);
      }
      console.log('[supervisor] all children exited, shutting down clean (0)');
      process.exit(0);
    }
    return;
  }

  // Otherwise this child crashed on its own. Restart it in place so one crashed
  // component doesn't take down the other (or the whole container). Escalate
  // only if it's crash-looping.
  const ranForMs = Date.now() - (child.startedAt || Date.now());
  if (ranForMs > HEALTHY_MS) child.restarts = 0; // ran healthy, then died — not a loop
  child.restarts = (child.restarts || 0) + 1;

  if (child.restarts > MAX_RESTARTS) {
    console.error(
      `[supervisor] ${child.name} crashed ${child.restarts}x within ${HEALTHY_MS / 1000}s windows — ` +
      `escalating to a full container restart`,
    );
    firstFailureCode = code && code !== 0 ? code : 1;
    escalate();
    return;
  }

  const delay = backoffFor(child.restarts - 1);
  console.warn(
    `[supervisor] ${child.name} exited (code=${code}); restarting in ${Math.round(delay / 1000)}s ` +
    `(attempt ${child.restarts}/${MAX_RESTARTS})`,
  );
  // NOT unref'd: if every child is briefly down (all crashed at once), this
  // pending respawn must keep the event loop alive — otherwise Node would exit 0
  // and Railway's ON_FAILURE policy would NOT restart us, causing a full outage.
  setTimeout(() => { if (!shuttingDown) spawnChild(child); }, delay);
}

function spawnChild(child) {
  const proc = spawn(child.cmd, child.args, {
    cwd: '/app',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.proc = proc;
  child.exited = false;
  child.startedAt = Date.now();
  pipePrefixed(proc.stdout, child, false);
  pipePrefixed(proc.stderr, child, true);
  // 'error' and 'exit' can both fire for one spawn; _handled dedupes per-process
  // so a single failure isn't counted (or restarted) twice.
  proc.on('exit', (code, signal) => {
    if (proc._handled) return;
    proc._handled = true;
    onChildExit(child, code, signal);
  });
  proc.on('error', (err) => {
    console.error(`[supervisor] ${child.name} spawn error:`, err.message);
    if (proc._handled) return;
    proc._handled = true;
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
