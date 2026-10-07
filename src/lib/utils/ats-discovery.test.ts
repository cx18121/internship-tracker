import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { discoverATSTarget } from '../../poller/ats';

describe('ATS targets config integrity', () => {
  test('iCIMS targets are absent from the maintained board list', () => {
    const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'ats-targets.json'), 'utf8'));
    assert.equal(config.targets.filter((t: { ats: string }) => t.ats === 'icims').length, 0);
  });

  test('stale volume targets and incoming discoveries cannot restore retired iCIMS polling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-retired-ats-'));
    const filename = path.join(dir, 'ats-targets.json');
    fs.writeFileSync(filename, JSON.stringify({ targets: [
      { slug: 'retired', ats: 'icims', name: 'Retired Source' },
      { slug: 'keep', ats: 'greenhouse', name: 'Keep Source' },
    ] }));
    try {
      const script = `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const { loadATSTargets, saveDiscoveredTargets } = require('./src/lib/utils/ats-discovery.ts');
        assert.deepEqual(loadATSTargets().map(t => t.slug), ['keep']);
        assert.equal(saveDiscoveredTargets([{ slug: 'new-retired', ats: 'icims', name: 'Must not return' }]), 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(process.env.DATA_DIR + '/ats-targets.json')).targets.map(t => t.slug), ['keep']);
        assert.equal(saveDiscoveredTargets([{ slug: 'new', ats: 'ashby', name: 'New Source' }]), 1);
        assert.deepEqual(loadATSTargets().map(t => t.slug), ['keep', 'new']);
      `;
      execFileSync(process.execPath, ['--require', 'tsx/cjs', '-e', script], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dir }, stdio: 'pipe' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('ats-targets.json: NVIDIA has board and wdInstance configured', () => {
    const configPath = path.join(process.cwd(), 'data', 'ats-targets.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const targets: any[] = config.targets || [];
    const nvidia = targets.find((t: any) => t.slug === 'nvidia' && t.ats === 'workday');
    assert.ok(nvidia, 'NVIDIA target must exist in ats-targets.json');
    assert.ok(nvidia.board, `NVIDIA must have board field, got: ${JSON.stringify(nvidia)}`);
    assert.ok(nvidia.wdInstance, 'NVIDIA must have wdInstance field');
    assert.equal(nvidia.board, 'NVIDIAExternalCareerSite', `Expected NVIDIAExternalCareerSite, got ${nvidia.board}`);
  });

  test('ats-targets.json: Intel and Boeing have required Workday fields', () => {
    const configPath = path.join(process.cwd(), 'data', 'ats-targets.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const targets: any[] = config.targets || [];

    const intel = targets.find((t: any) => t.slug === 'intel' && t.ats === 'workday');
    assert.ok(intel?.board, 'Intel must have board field');

    const boeing = targets.find((t: any) => t.slug === 'boeing' && t.ats === 'workday');
    assert.ok(boeing?.board, 'Boeing must have board field');
  });

  test('ats-discovery: Workday URL extracts slug, board, and wdInstance', () => {
    const target = discoverATSTarget(
      'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/12345',
      'NVIDIA'
    );
    assert.ok(target, 'Should return a target for Workday URL');
    assert.equal(target!.slug, 'nvidia');
    assert.equal(target!.ats, 'workday');
    assert.equal(target!.board, 'NVIDIAExternalCareerSite', `Expected board=NVIDIAExternalCareerSite, got ${target!.board}`);
    assert.equal(target!.wdInstance, 'wd5', `Expected wdInstance=wd5, got ${target!.wdInstance}`);
  });

  test('ats-discovery: Workday URL with locale prefix extracts correct board', () => {
    const target = discoverATSTarget(
      'https://intel.wd1.myworkdayjobs.com/en-US/External/job/123',
      'Intel'
    );
    assert.ok(target, 'Should return a target');
    assert.equal(target!.slug, 'intel');
    assert.equal(target!.board, 'External', `Expected board=External, got ${target!.board}`);
    assert.equal(target!.wdInstance, 'wd1');
  });

  test('ats-discovery: Greenhouse URL extracts slug correctly', () => {
    const target = discoverATSTarget('https://boards.greenhouse.io/anthropic/jobs/123', 'Anthropic');
    assert.ok(target, 'Should return target for Greenhouse URL');
    assert.equal(target!.slug, 'anthropic');
    assert.equal(target!.ats, 'greenhouse');
  });

  test('ats-discovery: Rippling URL extracts slug + ats', () => {
    const target = discoverATSTarget(
      'https://ats.rippling.com/rippling/jobs/35b3ba25-ff2e-4b68-a2d7-61be26f2b24a',
      'Rippling'
    );
    assert.ok(target, 'Should return a target for Rippling URL');
    assert.equal(target!.slug, 'rippling');
    assert.equal(target!.ats, 'rippling');
  });

  test('ats-discovery: Rippling URL with locale prefix skips locale segment', () => {
    // ats.rippling.com/en-US/{slug}/jobs/{uuid} — the locale must not be read as the slug
    const target = discoverATSTarget(
      'https://ats.rippling.com/en-US/inspectoriocareers/jobs/89ffbf49-5811-4258-a170-4223720eda86',
      'Inspectorio'
    );
    assert.ok(target, 'Should return a target');
    assert.equal(target!.slug, 'inspectoriocareers', `Expected slug=inspectoriocareers, got ${target!.slug}`);
    assert.equal(target!.ats, 'rippling');
  });

  test('ats-discovery: Workable URL extracts slug + ats', () => {
    const target = discoverATSTarget(
      'https://apply.workable.com/quadric-dot-i-o-inc/j/52EA39411C/apply',
      'Quadric'
    );
    assert.ok(target, 'Should return a target for Workable URL');
    assert.equal(target!.slug, 'quadric-dot-i-o-inc');
    assert.equal(target!.ats, 'workable');
  });

  test('ats-discovery: deny-list shape is valid + includes the audited dead slugs', () => {
    const denylistPath = path.join(process.cwd(), 'data', 'ats-discovery-denylist.json');
    assert.ok(fs.existsSync(denylistPath), 'data/ats-discovery-denylist.json must exist');
    const raw = JSON.parse(fs.readFileSync(denylistPath, 'utf-8'));
    assert.ok(Array.isArray(raw.denied), 'denylist.denied must be an array');
    for (const entry of raw.denied) {
      assert.ok(entry.slug && typeof entry.slug === 'string', `each entry needs a string slug, got ${JSON.stringify(entry)}`);
    }
    const slugs = new Set(raw.denied.map((e: { slug: string }) => e.slug));
    // Dead Workday tenants that SimplifyJobs link discovery keeps re-adding.
    for (const dead of ['kar', 'netflix', 'evrazna', 'cambiahealth']) {
      assert.ok(slugs.has(dead), `deny-list should include audited dead slug '${dead}'`);
    }
  });

  test('ats-discovery: non-ATS URL returns null', () => {
    const target = discoverATSTarget('https://linkedin.com/jobs/view/123', 'Some Company');
    assert.equal(target, null, 'Non-ATS URL should return null');
  });
});
