// One-time backfill: runs ATS discovery on all existing internship links
// and updates atsSource + saves new targets to ats-targets.json

import * as fs from 'fs';
import * as path from 'path';
import { discoverATSTarget, saveDiscoveredTargets } from '../lib/utils/ats-discovery.js';

const INTERNSHIPS_PATH = path.join(process.cwd(), 'data', 'internships.json');

const internships: any[] = JSON.parse(fs.readFileSync(INTERNSHIPS_PATH, 'utf-8'));

const counts = { updated: 0, alreadyKnown: 0, stillUnknown: 0, newTargets: 0 };
const discovered: any[] = [];

for (const item of internships) {
  const link = item.link || '';
  if (!link) { counts.stillUnknown++; continue; }

  const result = discoverATSTarget(link, item.company || '');
  if (result) {
    item.atsSource = result.ats;
    counts.updated++;
    discovered.push(result);
  } else {
    // Try to infer from simplify.jobs redirects or Handshake by source field
    if (item.source === 'SimplifyJobs' && !item.atsSource) {
      item.atsSource = 'simplify';
    } else if (item.source === 'Handshake') {
      item.atsSource = 'handshake';
    } else if (item.source === 'LinkedIn') {
      item.atsSource = 'linkedin';
    } else if (item.source === 'Indeed') {
      item.atsSource = 'indeed';
    } else {
      item.atsSource = 'unknown';
      counts.stillUnknown++;
      continue;
    }
    counts.alreadyKnown++;
  }
}

fs.writeFileSync(INTERNSHIPS_PATH, JSON.stringify(internships, null, 2));
console.log(`Backfill complete:`);
console.log(`  ATS URL detected: ${counts.updated}`);
console.log(`  Source-labeled (simplify/handshake/linkedin/indeed): ${counts.alreadyKnown}`);
console.log(`  Still unknown: ${counts.stillUnknown}`);

const newTargetCount = saveDiscoveredTargets(discovered);
console.log(`  New ATS targets added: ${newTargetCount}`);
