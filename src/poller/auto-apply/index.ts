import * as fs from 'fs';
import * as path from 'path';
import { Internship } from '../../lib/types.js';
import { AutoApplySettings, FillReport } from './types.js';
import { loadProfile, loadSettings } from './profile.js';
import { analyzeGreenhouseForm } from './greenhouse.js';
import { analyzeLeverForm } from './lever.js';
import { analyzeAshbyForm } from './ashby.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const REPORTS_PATH = path.join(DATA_DIR, 'auto-fill-reports.json');

// ── Report persistence ─────────────────────────────────────────────────────

export function loadReports(): Record<string, FillReport> {
  try {
    return JSON.parse(fs.readFileSync(REPORTS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveReport(report: FillReport): void {
  const reports = loadReports();
  reports[report.internshipId] = report;
  fs.writeFileSync(REPORTS_PATH, JSON.stringify(reports, null, 2), 'utf-8');
}

// ── Provider detection ─────────────────────────────────────────────────────

export function detectProvider(internship: Internship): string {
  if (internship.atsSource && internship.atsSource !== 'unknown') return internship.atsSource;
  const link = internship.link ?? '';
  if (link.includes('greenhouse.io')) return 'greenhouse';
  if (link.includes('lever.co')) return 'lever';
  if (link.includes('ashbyhq.com')) return 'ashby';
  return 'unknown';
}

// ── Eligibility check ──────────────────────────────────────────────────────

export function isEligible(internship: Internship, settings: AutoApplySettings): boolean {
  if (internship.applied) return false;

  const provider = detectProvider(internship);
  if (!settings.providers.includes(provider)) return false;

  if (internship.score !== null && internship.score < settings.minScore) return false;

  const labelOrder = ['A', 'B', 'C', 'D', 'F'];
  const minIdx = labelOrder.indexOf(settings.minLabel);
  const labelIdx = labelOrder.indexOf(internship.scoreLabel ?? 'F');
  if (labelIdx > minIdx) return false;

  return true;
}

// ── Daily usage tracking ───────────────────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDailyCount(): number {
  const reports = loadReports();
  const today = todayKey();
  return Object.values(reports).filter(r => r.fetchedAt.startsWith(today)).length;
}

// ── Core analyzer ──────────────────────────────────────────────────────────

export async function analyzeFill(internship: Internship): Promise<FillReport> {
  const profile = loadProfile();
  const provider = detectProvider(internship);

  const base: FillReport = {
    internshipId: internship.id,
    company: internship.company,
    title: internship.title,
    provider,
    applyUrl: internship.link,
    filledFields: [],
    humanFields: [],
    canAutoSubmit: false,
    fetchedAt: new Date().toISOString(),
  };

  if (!['greenhouse', 'lever', 'ashby'].includes(provider)) {
    return { ...base, error: `Unsupported provider: ${provider}` };
  }

  try {
    let result: { applyUrl: string; filledFields: FillReport['filledFields']; humanFields: FillReport['humanFields'] };

    if (provider === 'greenhouse') {
      result = await analyzeGreenhouseForm(internship.link, profile);
    } else if (provider === 'lever') {
      result = await analyzeLeverForm(internship.link, profile);
    } else {
      result = await analyzeAshbyForm(internship.link, profile);
    }

    const report: FillReport = {
      ...base,
      applyUrl: result.applyUrl,
      filledFields: result.filledFields,
      humanFields: result.humanFields,
      canAutoSubmit: result.humanFields.filter(f => f.required).length === 0,
    };

    saveReport(report);
    return report;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const report = { ...base, error: message };
    saveReport(report);
    return report;
  }
}

// ── Batch runner ───────────────────────────────────────────────────────────

export interface BatchResult {
  processed: number;
  skipped: number;
  errors: number;
  reports: FillReport[];
  dailyLimitReached: boolean;
}

export async function runBatch(internships: Internship[]): Promise<BatchResult> {
  const settings = loadSettings();
  const result: BatchResult = { processed: 0, skipped: 0, errors: 0, reports: [], dailyLimitReached: false };

  if (!settings.enabled) {
    result.skipped = internships.length;
    return result;
  }

  const existingReports = loadReports();
  let dailyCount = getDailyCount();

  for (const internship of internships) {
    if (dailyCount >= settings.dailyLimit) {
      result.dailyLimitReached = true;
      result.skipped += internships.length - result.processed - result.skipped;
      break;
    }

    // Skip if already analyzed today
    const existing = existingReports[internship.id];
    if (existing && existing.fetchedAt.startsWith(todayKey())) {
      result.skipped++;
      continue;
    }

    if (!isEligible(internship, settings)) {
      result.skipped++;
      continue;
    }

    const report = await analyzeFill(internship);
    result.reports.push(report);
    result.processed++;
    dailyCount++;

    if (report.error) result.errors++;
  }

  return result;
}
