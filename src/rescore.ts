import * as fs from 'fs';
import * as path from 'path';
import { scoreInternship } from './scorer';

const dataPath = path.join(process.cwd(), 'data', 'internships.json');
const internships: any[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
const rescored = internships.map((item: any) => {
  const result = scoreInternship(item);
  counts[result.scoreLabel] = (counts[result.scoreLabel] || 0) + 1;
  return { ...item, score: result.score, scoreLabel: result.scoreLabel, matchedKeywords: result.matchedKeywords };
});

fs.writeFileSync(dataPath, JSON.stringify(rescored, null, 2));
console.log('Re-scored', rescored.length, 'internships');
console.log('Distribution:', counts);
