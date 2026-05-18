import { pollJobSpy } from './src/pollers/jobspy.js';

async function main() {
  console.log('Testing JobSpy...');
  const results = await pollJobSpy();
  console.log('JobSpy returned:', results.length, 'jobs');
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
