import { pollHandshake } from './pollers/handshake.js';

async function main() {
  const results = await pollHandshake();
  console.log(`\nTotal results: ${results.length}`);
  if (results.length > 0) {
    console.log('\nFirst 3:');
    results.slice(0, 3).forEach(r => console.log(JSON.stringify(r, null, 2)));
  }
}

main().catch(e => console.error('Error:', e.message));
