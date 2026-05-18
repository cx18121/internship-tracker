#!/usr/bin/env node
/**
 * src/server.ts
 * Standalone API server — no polling, no scraping.
 * Run this as a long-lived process (via systemd).
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import { getInternships, getStats, patchInternship } from './store.js';
import { scoreInternship } from './scorer.js';
import { Internship } from './types.js';
import { analyzeFill, runBatch, loadReports, detectProvider, isEligible } from './auto-apply/index.js';
import { autoFill } from './auto-apply/playwright-fill.js';
import { loadProfile, saveProfile, loadSettings, saveSettings } from './auto-apply/profile.js';

const app = express();
const PORT = parseInt(process.env.API_PORT || '3001', 10);

app.use(express.json());

// CORS for Mission Control dashboard
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  next();
});

app.options('*', (_req, res) => res.sendStatus(204));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// GET /api/internships?source=&minScore=&label=&limit=&offset=&sort=score|newest|posted
app.get('/api/internships', (req, res) => {
  const rawSources = (req.query.sources as string | undefined) ?? (req.query.source as string | undefined);
  const singleSource = req.query.source as string | undefined;
  const multiSources = rawSources
    ? rawSources.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;
  const source = (multiSources && multiSources.length === 1) ? multiSources[0] : (singleSource && !multiSources ? singleSource : undefined);
  const sources = multiSources && multiSources.length > 1 ? multiSources : undefined;
  const rawScore = req.query.minScore ? parseInt(req.query.minScore as string, 10) : undefined;
  const minScore = rawScore !== undefined && Number.isFinite(rawScore) ? Math.max(0, Math.min(rawScore, 100)) : undefined;
  const label = req.query.label as string | undefined;
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 500, 1), 2000);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
  const sort = (req.query.sort as string) === 'newest' || req.query.sort === 'posted'
    ? (req.query.sort as 'newest' | 'posted')
    : 'score';
  const q = (req.query.q as string | undefined)?.trim();

  const all = getInternships({ source, minScore, label, sort, search: q });
  const page = all.slice(offset, offset + limit);
  res.json({ data: page, count: all.length });
});

// GET /api/internships/stats
app.get('/api/internships/stats', (_req, res) => {
  res.json(getStats());
});

// GET /api/internships/source-health
app.get('/api/internships/source-health', (_req, res) => {
  const internshipsPath = path.join(process.cwd(), 'data', 'internships.json');
  let internships: Internship[] = [];
  try { internships = JSON.parse(fs.readFileSync(internshipsPath, 'utf-8')); } catch { /* empty */ }

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const sourceMap = new Map<string, { total: number; last24h: number; last7d: number }>();

  for (const i of internships) {
    const entry = sourceMap.get(i.source) ?? { total: 0, last24h: 0, last7d: 0 };
    entry.total++;
    const age = now - new Date(i.seenAt).getTime();
    if (age <= day) entry.last24h++;
    if (age <= 7 * day) entry.last7d++;
    sourceMap.set(i.source, entry);
  }

  const sources = Array.from(sourceMap.entries()).map(([name, counts]) => ({ name, ...counts }));
  res.json({ sources });
});

// GET /api/internships/:id/score-breakdown
app.get('/api/internships/:id/score-breakdown', (req, res) => {
  const { id } = req.params;
  const all = getInternships({ includeArchived: true });
  const internship = all.find(i => i.id === id);
  if (!internship) { res.status(404).json({ error: 'Not found' }); return; }
  const breakdown = scoreInternship({
    title: internship.title, company: internship.company,
    location: internship.location, description: internship.description,
  });
  res.json(breakdown);
});

// PATCH /api/internships/:id
app.patch('/api/internships/:id', (req, res) => {
  const { id } = req.params;
  const allowedFields = ['applied', 'isNew', 'appliedAt', 'applicationUrl', 'applicationStatus'];
  const patch: Partial<Internship> = {};
  for (const key of allowedFields) {
    if (key in req.body) (patch as any)[key] = req.body[key];
  }
  const result = patchInternship(id, patch);
  if (!result) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(result);
});

// ── Auto-apply endpoints ──────────────────────────────────────────────────────

app.get('/api/auto-apply/settings', (_req, res) => res.json(loadSettings()));
app.post('/api/auto-apply/settings', (req, res) => {
  try { res.json(saveSettings(req.body)); } catch (err) { res.status(500).json({ error: String(err) }); }
});
app.get('/api/auto-apply/profile', (_req, res) => res.json(loadProfile()));
app.post('/api/auto-apply/profile', (req, res) => {
  try { res.json(saveProfile(req.body)); } catch (err) { res.status(500).json({ error: String(err) }); }
});
app.get('/api/auto-apply/reports', (_req, res) => res.json(loadReports()));
app.get('/api/auto-apply/reports/:id', (req, res) => {
  const reports = loadReports();
  const report = reports[req.params.id];
  if (!report) { res.status(404).json({ error: 'No report for this internship' }); return; }
  res.json(report);
});
app.post('/api/internships/:id/auto-apply', async (req, res) => {
  const { id } = req.params;
  const all = getInternships({ includeArchived: true });
  const internship = all.find(i => i.id === id);
  if (!internship) { res.status(404).json({ error: 'Internship not found' }); return; }
  const force = req.body?.force === true;
  if (!force) {
    const settings = loadSettings();
    if (!settings.enabled) { res.status(403).json({ error: 'auto-apply is disabled' }); return; }
    if (!isEligible(internship, settings)) {
      res.status(422).json({ error: 'Does not meet auto-apply criteria', score: internship.score,
        minScore: settings.minScore, provider: detectProvider(internship), providers: settings.providers });
      return;
    }
  }
  try {
    const report = await analyzeFill(internship);
    patchInternship(id, { applicationStatus: 'auto_fill_ready' } as Partial<Internship>);
    res.json(report);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});
app.post('/api/auto-apply/fill/:id', async (req, res) => {
  const { id } = req.params;
  const { resumePath } = req.body ?? {};
  const all = getInternships({ includeArchived: true });
  const internship = all.find(i => i.id === id);
  if (!internship) { res.status(404).json({ error: 'Internship not found' }); return; }
  const provider = detectProvider(internship);
  if (!provider) { res.status(422).json({ error: 'Cannot detect ATS provider' }); return; }
  try { res.json(await autoFill(internship.link, provider, loadProfile(), resumePath ?? '')); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});
app.post('/api/auto-apply/run', async (_req, res) => {
  const settings = loadSettings();
  if (!settings.enabled) { res.status(403).json({ error: 'auto-apply is disabled' }); return; }
  const all = getInternships({});
  try {
    const result = await runBatch(all);
    for (const report of result.reports) {
      if (!report.error) patchInternship(report.internshipId, { applicationStatus: 'auto_fill_ready' } as Partial<Internship>);
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});
app.get('/api/auto-apply/eligible', (_req, res) => {
  const settings = loadSettings();
  const all = getInternships({});
  const eligible = all.filter(i => isEligible(i, settings)).map(i => ({
    id: i.id, title: i.title, company: i.company, score: i.score,
    scoreLabel: i.scoreLabel, provider: detectProvider(i), link: i.link,
  }));
  res.json({ count: eligible.length, settings: { minScore: settings.minScore, minLabel: settings.minLabel }, internships: eligible });
});

const server = app.listen(PORT, () => {
  console.log(`[server] Internship API running on port ${PORT}`);
});

function shutdown(signal: string) {
  console.log(`[server] ${signal} — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));