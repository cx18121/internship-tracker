const { createHash } = require('crypto');
const { readFileSync } = require('fs');
const Database = require('better-sqlite3');

const seenRaw = JSON.parse(readFileSync('./data/seen.json', 'utf8'));
console.log('seen count:', seenRaw.length);

const db = new Database('./data/internships.db');
const rows = db.prepare("SELECT id, company, title, link, source FROM internships WHERE source='SimplifyJobs' LIMIT 20").all();
console.log('\nSimplifyJobs in DB:');
for (const r of rows) {
    console.log(`  id=${r.id.slice(0,20)} company="${r.company}" title="${r.title}" link="${r.link}"`);
}
// Check how many SimplifyJobs IDs are in seen
const sjIds = rows.map(r => r.id);
const inSeen = sjIds.filter(id => seenRaw.includes(id));
console.log(`\nOf first 20 SimplifyJobs rows, ${inSeen.length} IDs are in seen.json`);

// Get total count of SimplifyJobs in DB
const total = db.prepare("SELECT COUNT(*) as cnt FROM internships WHERE source='SimplifyJobs'").get();
console.log(`Total SimplifyJobs in DB: ${total.cnt}`);
db.close();
