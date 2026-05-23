import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Internship } from '../../lib/types';
import { buildInternshipRow } from '../utils/build-row';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'jobspy-config.json');
const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'jobspy_runner.py');
const VENV_PYTHON = path.join(process.cwd(), '.venv', 'bin', 'python3');
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — JobSpy can be slow

function getPython(): string {
  return fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';
}

interface RawJob {
  title: string;
  company: string;
  location: string;
  link: string;
  description?: string;
  source: string;
  postedAt: string;
}

export async function pollJobSpy(): Promise<Partial<Internship>[]> {
  if (!fs.existsSync(SCRIPT_PATH)) {
    console.warn('[jobspy] Runner script not found:', SCRIPT_PATH);
    return [];
  }

  return new Promise((resolve) => {
    const python = getPython();
    const proc = spawn(python, [SCRIPT_PATH, CONFIG_PATH], { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      console.warn('[jobspy] Timed out after 5 minutes — killing process');
      proc.kill();
      resolve([]);
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      stderr += line;
      // Stream progress to console as it comes
      process.stdout.write(line);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        console.warn(`[jobspy] Process exited with code ${code}`);
        resolve([]);
        return;
      }

      let parsed: RawJob[] = [];
      try {
        parsed = JSON.parse(stdout.trim());
      } catch (e: any) {
        console.warn('[jobspy] JSON parse error:', e.message);
        console.warn('[jobspy] Raw output snippet:', stdout.slice(0, 200));
        resolve([]);
        return;
      }

      const now = new Date().toISOString();
      const results: Partial<Internship>[] = parsed.map((j) => ({
        ...buildInternshipRow({
          title: j.title || '',
          company: j.company || '',
          location: j.location || '',
          link: j.link || '',
          source: j.source || 'JobSpy',
          upstreamPostedAt: j.postedAt,
          seenAt: now,
        }),
        description: j.description || '',
      }));

      console.log(`[jobspy] Fetched ${results.length} jobs`);
      resolve(results);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      console.warn('[jobspy] Spawn error:', err.message);
      resolve([]);
    });
  });
}
