/**
 * Test script for portal-scanner disappearance detection.
 * Simulates a 2-scan scenario:
 *   Scan 1: 5 listings on the "anthropic" Greenhouse board
 *   Scan 2: 3 listings on the same board (2 disappeared)
 *
 * Verifies that the 2 disappeared listings get marked archived.
 *
 * Run: node scripts/test-portal-scanner.mjs
 * (must be run from the internship-tracker directory)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'portal-snapshots.json');
const INTERNSHIPS_PATH = path.join(DATA_DIR, 'internships.json');

// Backup existing data files
const snapshotBackup = fs.existsSync(SNAPSHOT_PATH) ? fs.readFileSync(SNAPSHOT_PATH, 'utf-8') : null;
const internshipsBackup = fs.existsSync(INTERNSHIPS_PATH) ? fs.readFileSync(INTERNSHIPS_PATH, 'utf-8') : null;

function restoreBackups() {
  if (snapshotBackup !== null) {
    fs.writeFileSync(SNAPSHOT_PATH, snapshotBackup);
  } else if (fs.existsSync(SNAPSHOT_PATH)) {
    fs.unlinkSync(SNAPSHOT_PATH);
  }
  if (internshipsBackup !== null) {
    fs.writeFileSync(INTERNSHIPS_PATH, internshipsBackup);
  } else if (fs.existsSync(INTERNSHIPS_PATH)) {
    fs.unlinkSync(INTERNSHIPS_PATH);
  }
}

async function runTest() {
  console.log('=== Portal Disappearance Detection Test ===\n');

  // -------------------------------------------------------------------------
  // Setup: write 5 pre-existing listings (scan 1 state)
  // -------------------------------------------------------------------------
  const scan1 = [
    { id: 'gh-job-001', title: 'Intern 1', company: 'Anthropic', location: 'Remote', link: 'https://boards.greenhouse.io/anthropic/jobs/1001', source: 'Greenhouse', postedAt: '2026-04-01T00:00:00Z', seenAt: '2026-04-08T00:00:00Z', atsSource: 'Greenhouse', atsJobId: '1001', atsTarget: 'anthropic', score: 80, scoreLabel: 'Strong', matchedKeywords: ['ai'], isNew: false, applied: false },
    { id: 'gh-job-002', title: 'Intern 2', company: 'Anthropic', location: 'Remote', link: 'https://boards.greenhouse.io/anthropic/jobs/1002', source: 'Greenhouse', postedAt: '2026-04-01T00:00:00Z', seenAt: '2026-04-08T00:00:00Z', atsSource: 'Greenhouse', atsJobId: '1002', atsTarget: 'anthropic', score: 80, scoreLabel: 'Strong', matchedKeywords: ['ai'], isNew: false, applied: false },
    { id: 'gh-job-003', title: 'Intern 3', company: 'Anthropic', location: 'Remote', link: 'https://boards.greenhouse.io/anthropic/jobs/1003', source: 'Greenhouse', postedAt: '2026-04-01T00:00:00Z', seenAt: '2026-04-08T00:00:00Z', atsSource: 'Greenhouse', atsJobId: '1003', atsTarget: 'anthropic', score: 80, scoreLabel: 'Strong', matchedKeywords: ['ai'], isNew: false, applied: false },
    { id: 'gh-job-004', title: 'Intern 4', company: 'Anthropic', location: 'Remote', link: 'https://boards.greenhouse.io/anthropic/jobs/1004', source: 'Greenhouse', postedAt: '2026-04-01T00:00:00Z', seenAt: '2026-04-08T00:00:00Z', atsSource: 'Greenhouse', atsJobId: '1004', atsTarget: 'anthropic', score: 80, scoreLabel: 'Strong', matchedKeywords: ['ai'], isNew: false, applied: false },
    { id: 'gh-job-005', title: 'Intern 5', company: 'Anthropic', location: 'Remote', link: 'https://boards.greenhouse.io/anthropic/jobs/1005', source: 'Greenhouse', postedAt: '2026-04-01T00:00:00Z', seenAt: '2026-04-08T00:00:00Z', atsSource: 'Greenhouse', atsJobId: '1005', atsTarget: 'anthropic', score: 80, scoreLabel: 'Strong', matchedKeywords: ['ai'], isNew: false, applied: false },
  ];

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INTERNSHIPS_PATH, JSON.stringify(scan1, null, 2));
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({
    anthropic: { timestamp: '2026-04-08T00:00:00Z', jobIds: ['1001', '1002', '1003', '1004', '1005'] },
  }, null, 2));
  console.log('Setup: wrote 5 pre-existing listings + scan-1 snapshot');

  // -------------------------------------------------------------------------
  // Simulate scan 2: only 3 jobs remain (1001, 1002, 1003), 1004 and 1005 gone
  // -------------------------------------------------------------------------
  const scan2Snapshot = {
    anthropic: { timestamp: '2026-04-09T00:00:00Z', jobIds: ['1001', '1002', '1003'] },
  };
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(scan2Snapshot, null, 2));

  // Now re-run the scanner logic (simulate scanPortals call)
  // We call scanPortals from the actual module, but it will call pollATS().
  // To avoid actual HTTP calls, we mock by directly exercising archiveDisappeared.
  // Instead, load the scanner module and call its internal logic directly.

  const { archiveDisappeared } = await import('../src/pollers/portal-scanner.js');

  // Reload internships as they would be after scan 1
  const internships = JSON.parse(fs.readFileSync(INTERNSHIPS_PATH, 'utf-8'));
  const currentJobIds = new Set(['1001', '1002', '1003']);

  const result = archiveDisappeared(internships, currentJobIds, 'Greenhouse', 'anthropic');

  console.log(`\nResult: archived ${result.archived.length} listing(s)`);
  console.log('Archived IDs:', result.archived);

  // -------------------------------------------------------------------------
  // Assertions
  // -------------------------------------------------------------------------
  const passed =
    result.archived.length === 2 &&
    result.archived.includes('gh-job-004') &&
    result.archived.includes('gh-job-005') &&
    internships.every(i => i.id === 'gh-job-004' || i.id === 'gh-job-005' ? i.archived === true : i.archived !== true);

  if (passed) {
    console.log('\n✅ ALL ASSERTIONS PASSED');
    console.log('   - gh-job-004 and gh-job-005 correctly marked archived');
    console.log('   - gh-job-001, gh-job-002, gh-job-003 correctly left alone');
  } else {
    console.log('\n❌ TEST FAILED');
    console.log('Expected 2 archived (gh-job-004, gh-job-005), got:', result.archived.length);
    process.exitCode = 1;
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  restoreBackups();
  console.log('\nCleanup: restored original data files');
}

runTest().catch(err => {
  console.error('Test threw:', err);
  restoreBackups();
  process.exit(1);
});
