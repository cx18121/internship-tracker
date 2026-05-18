#!/usr/bin/env npx tsx
/**
 * migrate-dedup-links.ts
 *
 * Deduplicates existing internship entries that differ only by UTM tracking params.
 * For entries with the same company+title+normalized_link, keeps the one with the
 * most recent seenAt, archives others.
 *
 * Also updates seen.json to add old IDs of archived entries (prevents re-discovery).
 *
 * Run once. Safe to re-run (idempotent).
 */
import * as fs from 'fs';
import * as path from 'path';
import md5 from 'md5';

const dataDir = path.join(process.cwd(), 'data');
const internshipsPath = path.join(dataDir, 'internships.json');
const seenPath = path.join(dataDir, 'seen.json');
const BACKUP_SUFFIX = '.utm-migration-backup';

interface Internship {
  id: string;
  title: string;
  company: string;
  location: string;
  link: string;
  source: string;
  postedAt: string;
  seenAt: string;
  score?: number;
  scoreLabel?: string;
  matchedKeywords?: string[];
  isNew?: boolean;
  applied?: boolean;
  archived?: boolean;
  [key: string]: unknown;
}

function stripUtm(url: string): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const TRACKING_PARAMS = new Set([
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'utm_id', 'utm_cid', 'utm_reader', 'utm_viz_id',
      'ref', 'referrer', 'ref_', ' affiliated', 'affiliate', 'partner',
      'source', 'trk', 'trkInfo', 'trkCampaign',
      'ic', 'i', 'jk', 'iorq', 'vnp', 'vnp_',
    ]);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    const hash = parsed.hash.replace(/#*(utm-|ref=|trk=).*/i, '');
    parsed.hash = hash.startsWith('#') ? hash : '';
    return parsed.toString().replace(/\?$/, '');
  } catch {
    return url.replace(/[?#]&*(utm_|ref|trk|affiliated|affiliate|partner|source)=[^&#]*/gi, '').replace(/\?$/, '');
  }
}

function main() {
  const internships: Internship[] = JSON.parse(fs.readFileSync(internshipsPath, 'utf-8'));
  const seenIds: string[] = JSON.parse(fs.readFileSync(seenPath, 'utf-8'));

  console.log(`Loaded ${internships.length} internships, ${seenIds.length} seen IDs`);

  // Backup
  fs.copyFileSync(internshipsPath, internshipsPath + BACKUP_SUFFIX);
  fs.copyFileSync(seenPath, seenPath + BACKUP_SUFFIX);
  console.log(`Backed up to ${BACKUP_SUFFIX}`);

  // Group non-archived entries by (company, title, normalized_link)
  const byKey = new Map<string, Internship[]>();
  for (const i of internships) {
    if (i.archived) continue;
    const norm = stripUtm(i.link || '');
    if (!norm) continue;
    const key = `${i.company}|${i.title}|${norm}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(i);
  }

  const idsToArchive = new Set<string>();
  const idsToAddToSeen = new Set<string>();

  for (const [key, entries] of byKey) {
    if (entries.length <= 1) continue;
    // Sort by seenAt descending — newest first
    entries.sort((a, b) => b.seenAt.localeCompare(a.seenAt));
    const [keep, ...duplicates] = entries;

    console.log(`Dedup: "${keep.company}" "${keep.title}" — ${entries.length} entries, archiving ${duplicates.length}`);

    // Archive duplicates
    for (const d of duplicates) {
      idsToArchive.add(d.id);
      idsToAddToSeen.add(d.id); // prevent re-discovery
    }

    // Normalize the kept entry's link (clean up stored URL)
    keep.link = stripUtm(keep.link || '') || keep.link;
  }

  if (idsToArchive.size === 0) {
    console.log('No duplicates found. Nothing to do.');
    return;
  }

  // Archive duplicates in internships.json
  let archived = 0;
  for (const i of internships) {
    if (idsToArchive.has(i.id)) {
      i.archived = true;
      archived++;
    }
  }

  // Add archived IDs to seen.json so scraper won't re-discover them
  const newSeenCount = [...idsToAddToSeen].filter(id => !seenIds.includes(id)).length;
  seenIds.push(...idsToAddToSeen);

  fs.writeFileSync(internshipsPath, JSON.stringify(internships, null, 2));
  fs.writeFileSync(seenPath, JSON.stringify(seenIds, null, 2));

  console.log(`Archived ${archived} duplicate entries.`);
  console.log(`Added ${newSeenCount} archived IDs to seen.json (${seenIds.length} total).`);
  console.log('Migration complete.');
}

main();
