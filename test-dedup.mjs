// Test dedup by simulating what store.ts does
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const seenRaw = JSON.parse(readFileSync('./data/seen.json', 'utf8'));
console.log('seen.json count:', seenRaw.length);
console.log('sample ids:', seenRaw.slice(0, 5));

// Check 3 known SimplifyJobs IDs from the 1240 postings
const testEntries = [
  { company: 'Anduril', title: 'Software Engineer Intern', link: 'https://www.anduril.com/careers/swe-intern' },
  { company: 'SpaceX', title: 'Software Engineering Intern', link: 'https://spacex.com/careers/swe-intern' },
  { company: 'Scale AI', title: 'Software Engineer Intern', link: 'https://scale.ai/careers/swe-intern' },
];

for (const e of testEntries) {
  const id = createHash('md5').update(`${e.company}${e.title}${e.link}`).digest('hex');
  const inSeen = seenRaw.includes(id);
  console.log(`${e.company}: id=${id.slice(0,16)}..., inSeen=${inSeen}`);
}

// Also check what the 1240 github results would generate IDs for
// Let's look at the raw github poller output format
console.log('\nCheck dedup logic in store.ts...');