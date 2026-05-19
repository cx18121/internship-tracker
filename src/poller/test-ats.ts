import { pollATS } from './pollers/ats';
pollATS().then(r => {
  console.log('ATS total:', r.length);
  const bySrc = r.reduce((a: any, j) => { a[j.source!] = (a[j.source!]||0)+1; return a; }, {});
  console.log('By source:', JSON.stringify(bySrc));
  r.slice(0, 3).forEach(j => console.log(JSON.stringify({title: j.title, company: j.company, source: j.source})));
}).catch((e: any) => console.error(e));
