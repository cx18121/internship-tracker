/**
 * src/utils/logger.ts
 * JSON logger — structured logging with daily rotation, 7-day retention.
 *
 * Log format: {"timestamp","level","service","message","data"}
 * Levels: INFO, WARN, ERROR
 * Output: /home/cxue/.openclaw/workspace/internship-tracker/logs/app.log
 * Rotates daily (renames to app-YYYY-MM-DD.log), keeps last 7 files.
 */

import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const SERVICE_NAME = 'internship-tracker';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  data?: Record<string, unknown>;
}

function ensureLogDir(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch { /* ignore */ }
}

function rotateIfNeeded(): void {
  try {
    ensureLogDir();
    if (!fs.existsSync(LOG_FILE)) return;

    const stat = fs.statSync(LOG_FILE);
    const age = Date.now() - stat.mtimeMs;
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    if (age >= ONE_DAY_MS) {
      const dateStr = new Date(stat.mtimeMs).toISOString().slice(0, 10); // YYYY-MM-DD
      const rotatedPath = path.join(LOG_DIR, `app-${dateStr}.log`);
      fs.renameSync(LOG_FILE, rotatedPath);
      pruneOldLogs();
    }
  } catch { /* ignore rotation errors */ }
}

function pruneOldLogs(): void {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('app-') && f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: path.join(LOG_DIR, f),
        mtime: fs.statSync(path.join(LOG_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    const toDelete = files.slice(7); // keep most recent 7
    for (const f of toDelete) {
      try { fs.unlinkSync(f.path); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function writeLog(entry: LogEntry): void {
  try {
    ensureLogDir();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch { /* last-resort silent drop */ }
}

function formatEntry(level: LogLevel, message: string, data?: Record<string, unknown>): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    message,
    ...(data !== undefined ? { data } : {}),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export const logger = {
  info(message: string, data?: Record<string, unknown>): void {
    rotateIfNeeded();
    writeLog(formatEntry('INFO', message, data));
  },
  warn(message: string, data?: Record<string, unknown>): void {
    rotateIfNeeded();
    writeLog(formatEntry('WARN', message, data));
  },
  error(message: string, data?: Record<string, unknown>): void {
    rotateIfNeeded();
    writeLog(formatEntry('ERROR', message, data));
  },
};

export default logger;