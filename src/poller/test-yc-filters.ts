import { pollYCWaaS } from './pollers/yc-waas.js';
import { filterInternships } from './filter.js';

async function main() {
  const jobs = await pollYCWaaS();
  console.log(`\n=== Raw from YC WaaS: ${jobs.length} jobs ===`);
  jobs.forEach(j => console.log(`  [${j.source}] ${j.company} | ${j.title} | loc=${j.location}`));

  const { passed, counts } = filterInternships(jobs);
  console.log(`\n=== After filter: ${passed.length} passed ===`);
  console.log('Counts:', JSON.stringify(counts));
  passed.forEach(j => console.log(`  PASS: ${j.company} | ${j.title} | loc=${j.location}`));
}

main().catch(console.error);
