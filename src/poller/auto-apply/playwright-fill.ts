/**
 * Playwright-based auto-fill orchestrator.
 *
 * Uses Playwright to automate form filling on:
 *   - LinkedIn Easy Apply (multi-step modal)
 *   - Greenhouse (stored application form)
 *   - Lever (apply form)
 *   - Ashby (application form)
 *
 * Each provider has its own fill*() implementation below.
 */

import { firefox, Browser, Page } from 'playwright';
import * as path from 'path';
import { ApplicantProfile, FillField, FillReport } from './types';
import { loadProfile } from './profile';
import {
  analyzeLinkedInForm,
  fillLinkedInForm,
  isLinkedInEasyApplyUrl,
} from './linkedin';
import { analyzeGreenhouseForm } from './greenhouse';
import { analyzeLeverForm } from './lever';
import { analyzeAshbyForm } from './ashby';

// ── Browser management ────────────────────────────────────────────────────

interface BrowserPool {
  browser: Browser;
  maxAge: number; // ms since last use
}

let _pool: BrowserPool | null = null;
const POOL_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Acquires (or creates) a pooled Firefox browser instance.
 * Caller must call releaseBrowser() when done.
 */
async function acquireBrowser(): Promise<Browser> {
  const now = Date.now();
  if (_pool && (now - _pool.maxAge) < POOL_MAX_AGE_MS) {
    // Reuse existing browser (maxAge tracks last use)
    _pool.maxAge = now;
    return _pool.browser;
  }

  // Close old browser if exists
  if (_pool) {
    await _pool.browser.close().catch(() => {});
    _pool = null;
  }

  const browser = await firefox.launch({
    headless: true,
    args: ['-no-sandbox', '-disable-setuid-sandbox'],
  });

  _pool = { browser, maxAge: now };
  return browser;
}

export async function releaseBrowser(): Promise<void> {
  // For now, keep the browser alive for reuse
  // Future: implement actual release/close logic if needed
  if (_pool) _pool.maxAge = Date.now();
}

// ── Screenshot helper ───────────────────────────────────────────────────────

async function screenshot(page: Page, prefix: string): Promise<string> {
  const ts = Date.now();
  const p = `/tmp/auto-fill-${prefix}-${ts}.png`;
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

// ── Common form fill helpers ───────────────────────────────────────────────

/**
 * Fills a standard form field by label-matching the closest input/select/textarea.
 * Falls back to name and aria-label matching.
 */
async function fillFieldByLabel(
  page: Page,
  label: string,
  value: string,
  type: FillField['type'],
): Promise<boolean> {
  const normalized = label.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const patterns = [
    `label:${normalized}`,
    `input[name="${label.toLowerCase().replace(/ /g, '_')}"]`,
    `input[aria-label*="${label}"]`,
    `input[id*="${label}"]`,
    `textarea[name*="${label}"]`,
  ];

  if (type === 'select') {
    const sel = page.locator(patterns.join(', ')).first();
    if (await sel.count() > 0) {
      await sel.selectOption(value, { timeout: 3000 });
      return true;
    }
  } else if (type === 'checkbox') {
    const sel = page.locator(patterns.join(', ')).first();
    if (await sel.count() > 0) {
      if (value === 'true' || value === 'yes') await sel.check({ timeout: 3000 });
      return true;
    }
  } else {
    for (const p of patterns) {
      const sel = page.locator(p).first();
      if (await sel.count() > 0) {
        await sel.fill(value, { timeout: 3000 });
        return true;
      }
    }
  }

  return false;
}

// ── Greenhouse fill ────────────────────────────────────────────────────────

async function fillGreenhouseForm(
  page: Page,
  report: FillReport,
): Promise<{ screenshotPath: string; filledFields: string[]; skippedFields: string[] }> {
  const screenshotPath = await screenshot(page, 'greenhouse');

  const filledFields: string[] = [];
  const skippedFields: string[] = [];

  for (const field of report.filledFields) {
    if (!field.value) { skippedFields.push(field.name); continue; }
    try {
      const sel = page.locator(
        `input[name="${field.name}"], textarea[name="${field.name}"], ` +
        `select[name="${field.name}"], input[aria-label*="${field.label}"]`,
      ).first();

      if (await sel.count() > 0) {
        if (field.type === 'select') {
          await sel.selectOption(field.value, { timeout: 3000 });
        } else {
          await sel.fill(field.value, { timeout: 3000 });
        }
        filledFields.push(field.name);
      } else {
        skippedFields.push(field.name);
      }
    } catch {
      skippedFields.push(field.name);
    }
  }

  return { screenshotPath, filledFields, skippedFields };
}

// ── Lever fill ─────────────────────────────────────────────────────────────

async function fillLeverForm(
  page: Page,
  report: FillReport,
): Promise<{ screenshotPath: string; filledFields: string[]; skippedFields: string[] }> {
  const screenshotPath = await screenshot(page, 'lever');

  const filledFields: string[] = [];
  const skippedFields: string[] = [];

  for (const field of report.filledFields) {
    if (!field.value) { skippedFields.push(field.name); continue; }
    try {
      const sel = page.locator(
        `input[name="${field.name}"], textarea[name="${field.name}"], ` +
        `select[name="${field.name}"], input[aria-label*="${field.label}"]`,
      ).first();

      if (await sel.count() > 0) {
        if (field.type === 'select') {
          await sel.selectOption(field.value, { timeout: 3000 });
        } else {
          await sel.fill(field.value, { timeout: 3000 });
        }
        filledFields.push(field.name);
      } else {
        skippedFields.push(field.name);
      }
    } catch {
      skippedFields.push(field.name);
    }
  }

  return { screenshotPath, filledFields, skippedFields };
}

// ── Ashby fill ─────────────────────────────────────────────────────────────

async function fillAshbyForm(
  page: Page,
  report: FillReport,
): Promise<{ screenshotPath: string; filledFields: string[]; skippedFields: string[] }> {
  const screenshotPath = await screenshot(page, 'ashby');

  const filledFields: string[] = [];
  const skippedFields: string[] = [];

  for (const field of report.filledFields) {
    if (!field.value) { skippedFields.push(field.name); continue; }
    try {
      // Ashby uses UUID paths as field identifiers — match by label or placeholder
      const sel = page.locator(
        `input[name="${field.name}"], textarea[name="${field.name}"], ` +
        `select[name="${field.name}"], input[placeholder*="${field.label}"], ` +
        `input[id="${field.name}"], input[aria-label*="${field.label}"]`,
      ).first();

      if (await sel.count() > 0) {
        if (field.type === 'select') {
          await sel.selectOption(field.value, { timeout: 3000 });
        } else {
          await sel.fill(field.value, { timeout: 3000 });
        }
        filledFields.push(field.name);
      } else {
        skippedFields.push(field.name);
      }
    } catch {
      skippedFields.push(field.name);
    }
  }

  return { screenshotPath, filledFields, skippedFields };
}

// ── Main fill entry point ──────────────────────────────────────────────────

export interface AutoFillResult {
  provider: string;
  applyUrl: string;
  screenshotPath: string;
  filledFields: string[];
  skippedFields: string[];
  humanFields: FillField[];
  completed: boolean;
  error?: string;
}

/**
 * Orchestrates Playwright-based form filling for an internship.
 *
 * Flow:
 *  1. Analyze the form (determine fields + which need human review)
 *  2. Open browser → navigate to apply URL
 *  3. Fill auto-fillable fields
 *  4. Take screenshot for human review
 *  5. Return result
 *
 * The `resumePath` should be an absolute path to a local PDF.
 */
export async function autoFill(
  applyUrl: string,
  provider: string,
  profile: ApplicantProfile,
  resumePath: string,
): Promise<AutoFillResult> {
  // ── Step 1: Analyze the form to get field definitions ──────────────────
  let report: FillReport;
  if (provider === 'linkedin' && isLinkedInEasyApplyUrl(applyUrl)) {
    const result = await analyzeLinkedInForm(applyUrl, profile);
    report = {
      internshipId: '',
      company: '',
      title: '',
      provider,
      applyUrl,
      filledFields: result.filledFields,
      humanFields: result.humanFields,
      canAutoSubmit: false,
      fetchedAt: new Date().toISOString(),
    };
  } else if (provider === 'greenhouse') {
    const result = await analyzeGreenhouseForm(applyUrl, profile);
    report = { internshipId: '', company: '', title: '', provider, ...result, canAutoSubmit: false, fetchedAt: new Date().toISOString() };
  } else if (provider === 'lever') {
    const result = await analyzeLeverForm(applyUrl, profile);
    report = { internshipId: '', company: '', title: '', provider, ...result, canAutoSubmit: false, fetchedAt: new Date().toISOString() };
  } else if (provider === 'ashby') {
    const result = await analyzeAshbyForm(applyUrl, profile);
    report = { internshipId: '', company: '', title: '', provider, ...result, canAutoSubmit: false, fetchedAt: new Date().toISOString() };
  } else {
    return {
      provider,
      applyUrl,
      screenshotPath: '',
      filledFields: [],
      skippedFields: [],
      humanFields: [],
      completed: false,
      error: `Unsupported provider: ${provider}`,
    };
  }

  // ── Step 2: Open browser and navigate ─────────────────────────────────
  const browser = await acquireBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  let screenshotPath = '';
  let filledFields: string[] = [];
  let skippedFields: string[] = [];
  let completed = false;
  let error: string | undefined;

  try {
    await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    screenshotPath = await screenshot(page, `${provider}-initial`);

    // ── Step 3: Fill form fields ────────────────────────────────────────
    if (provider === 'linkedin') {
      // LinkedIn Easy Apply — multi-step
      const resumeAbs = path.isAbsolute(resumePath) ? resumePath : path.join(process.cwd(), resumePath);
      const result = await fillLinkedInForm(page, profile, resumeAbs);
      screenshotPath = result.screenshotPath;
      filledFields = result.steps.flatMap(s => s.filledFields);
      skippedFields = result.steps.flatMap(s => s.skippedFields);
      completed = result.completed;
    } else if (provider === 'greenhouse') {
      const r = await fillGreenhouseForm(page, report);
      screenshotPath = r.screenshotPath;
      filledFields = r.filledFields;
      skippedFields = r.skippedFields;
    } else if (provider === 'lever') {
      const r = await fillLeverForm(page, report);
      screenshotPath = r.screenshotPath;
      filledFields = r.filledFields;
      skippedFields = r.skippedFields;
    } else if (provider === 'ashby') {
      const r = await fillAshbyForm(page, report);
      screenshotPath = r.screenshotPath;
      filledFields = r.filledFields;
      skippedFields = r.skippedFields;
    }
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
    screenshotPath = await screenshot(page, `${provider}-error`).catch(() => '');
  } finally {
    await context.close().catch(() => {});
  }

  return {
    provider,
    applyUrl,
    screenshotPath,
    filledFields,
    skippedFields,
    humanFields: report.humanFields,
    completed,
    error,
  };
}

// ── Convenience wrapper: fill from an internship link + profile ────────────

export async function autoFillInternship(
  applyUrl: string,
  provider: string,
  resumePath?: string,
): Promise<AutoFillResult> {
  const profile = loadProfile();
  const resume = resumePath ?? profile.resumeUrl;
  return autoFill(applyUrl, provider, profile, resume);
}
