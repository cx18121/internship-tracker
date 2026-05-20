#!/usr/bin/env node
/**
 * Boot-time config reconciliation between the image and the persistent volume.
 *
 * Three categories of files in /app/data-defaults:
 *
 *   1. MERGE_FILES — config that ships with the image but ALSO accretes at
 *      runtime (e.g., ats-targets.json gets new entries from saveDiscoveredTargets
 *      in the handshake/github pollers). Image wins on key collision; volume-only
 *      entries are preserved.
 *
 *   2. OVERWRITE_FILES — pure config, no runtime mutation. Always overwrite
 *      with the image version so updates ship via redeploy.
 *
 *   3. Everything else — runtime state. Seed-if-missing only (current behavior).
 *
 * This script replaces the shell-based seeding in docker-entrypoint.sh.
 *
 * Idempotent: safe to run on every boot. Fails loud (non-zero exit) only on
 * unparseable JSON in a MERGE_FILES entry; everything else just logs and
 * moves on.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = '/app/data';
const DEFAULTS_DIR = '/app/data-defaults';

const MERGE_FILES = {
  // Map of filename → merge strategy.
  // 'ats-targets-union': merge { targets: [...] } by (ats + slug.toLowerCase()),
  // image wins on collision.
  'ats-targets.json': 'ats-targets-union',
};

const OVERWRITE_FILES = new Set([
  'scoring-config.json',     // scoring tuning ships from source, no runtime writes
  'jobspy-config.json',      // poll query config, source-controlled
  'resume.pdf',              // ships from source (currently used only locally)
]);

// companies.yml stays seed-if-missing: it was historically mutated by the now-
// retired websearch-discovery poller. It's currently consumed by nothing in
// the runtime (careers-scan is also retired); kept seedable so future tooling
// can still read it.

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    console.error(`[seed-config] Failed to parse ${p}: ${err.message}`);
    return null;
  }
}

function atsTargetsUnion(imagePath, volumePath) {
  const image = readJsonSafe(imagePath);
  if (!image || !Array.isArray(image.targets)) {
    console.warn(`[seed-config] ${path.basename(imagePath)} has no targets[]; leaving volume alone`);
    return null;
  }

  const volume = fs.existsSync(volumePath) ? readJsonSafe(volumePath) : null;
  const volumeTargets = Array.isArray(volume?.targets) ? volume.targets : [];

  const key = (t) => `${(t.ats || '').toLowerCase()}::${(t.slug || '').toLowerCase()}`;
  const seen = new Set();
  const merged = [];

  // Image first — image entries win on collision
  for (const t of image.targets) {
    const k = key(t);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(t);
  }
  // Then volume-only entries (preserves runtime discoveries)
  let preserved = 0;
  for (const t of volumeTargets) {
    const k = key(t);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(t);
    preserved++;
  }

  const result = { ...image, targets: merged };
  return { result, preserved, fromImage: image.targets.length, fromVolume: volumeTargets.length };
}

function main() {
  if (!fs.existsSync(DEFAULTS_DIR)) {
    console.log('[seed-config] No /app/data-defaults — first-run image likely; nothing to do');
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  for (const entry of fs.readdirSync(DEFAULTS_DIR)) {
    const imagePath = path.join(DEFAULTS_DIR, entry);
    const volumePath = path.join(DATA_DIR, entry);
    const stat = fs.statSync(imagePath);

    // Directories: seed-if-missing (matches old behavior; needed for any data-defaults
    // sub-trees we might add later).
    if (stat.isDirectory()) {
      if (!fs.existsSync(volumePath)) {
        fs.cpSync(imagePath, volumePath, { recursive: true });
        console.log(`[seed-config] seeded data/${entry}/ from defaults`);
      }
      continue;
    }

    if (MERGE_FILES[entry] === 'ats-targets-union') {
      const m = atsTargetsUnion(imagePath, volumePath);
      if (m) {
        fs.writeFileSync(volumePath, JSON.stringify(m.result, null, 2));
        console.log(
          `[seed-config] merged data/${entry}: image=${m.fromImage} + volume-only=${m.preserved} → ${m.result.targets.length} total`,
        );
      }
      continue;
    }

    if (OVERWRITE_FILES.has(entry)) {
      fs.copyFileSync(imagePath, volumePath);
      console.log(`[seed-config] overwrote data/${entry} from defaults (config)`);
      continue;
    }

    // Default: seed-if-missing
    if (!fs.existsSync(volumePath)) {
      fs.copyFileSync(imagePath, volumePath);
      console.log(`[seed-config] seeded data/${entry} from defaults`);
    }
  }
}

main();
