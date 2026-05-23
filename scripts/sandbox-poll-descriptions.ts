// Live sandbox — hits real upstream APIs to verify the new
// description pipeline (buildInternshipRow's descriptionHtml/description
// seed contract → stripHtml → trim → undefined-collapse) actually produces
// populated descriptions end-to-end.
//
// Does NOT write to the DB. Just reports per-source coverage.
//
// Usage: npx tsx scripts/sandbox-poll-descriptions.ts

import axios from 'axios';
import {
  extractLeverDescription,
  fetchAshbyDescription,
  fetchSmartRecruitersDescription,
} from '../src/poller/utils/description-fetchers';
import { buildInternshipRow } from '../src/poller/utils/build-row';
import { smartTrimDescription } from '../src/poller/utils/description-trim';

const TIMEOUT_MS = 10_000;

interface Result {
  source: string;
  target: string;
  total: number;
  withDesc: number;
  sampleDescHead: string | null;
  sampleAfterSmartTrim: string | null;
}

function reportRow(r: Result): void {
  const pct = r.total > 0 ? Math.round((r.withDesc / r.total) * 100) : 0;
  console.log(`  ${r.source.padEnd(16)} ${r.target.padEnd(20)} ${r.withDesc}/${r.total} (${pct}%)`);
  if (r.sampleDescHead) {
    console.log(`    sample raw:        ${r.sampleDescHead}`);
    console.log(`    sample post-trim:  ${r.sampleAfterSmartTrim}`);
  }
}

async function probeGreenhouse(slug: string, name: string): Promise<Result> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  try {
    const { data } = await axios.get(url, { timeout: TIMEOUT_MS });
    const interns = (data.jobs || []).filter((j: any) => /\bintern(ship)?\b/i.test(j.title || ''));
    const rows = interns.map((j: any) =>
      buildInternshipRow({
        title: j.title || '',
        company: name,
        link: j.absolute_url || `https://boards.greenhouse.io/${slug}/jobs/${j.id}`,
        source: 'Greenhouse',
        seenAt: new Date().toISOString(),
        descriptionHtml: typeof j.content === 'string' ? j.content.slice(0, 20_000) : undefined,
      }),
    );
    const withDesc = rows.filter((r: any) => r.description).length;
    const sample = rows.find((r: any) => r.description);
    return {
      source: 'Greenhouse',
      target: name,
      total: rows.length,
      withDesc,
      sampleDescHead: sample?.description?.slice(0, 100) ?? null,
      sampleAfterSmartTrim: sample?.description ? smartTrimDescription(sample.description).slice(0, 100) : null,
    };
  } catch (e: any) {
    console.log(`  Greenhouse ${name}: error ${e.message}`);
    return { source: 'Greenhouse', target: name, total: 0, withDesc: 0, sampleDescHead: null, sampleAfterSmartTrim: null };
  }
}

async function probeLever(slug: string, name: string): Promise<Result> {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  try {
    const { data } = await axios.get(url, { timeout: TIMEOUT_MS });
    const postings: any[] = Array.isArray(data) ? data : [];
    const interns = postings.filter((j) =>
      /\bintern(ship)?\b/i.test(j.text || '') ||
      (j.categories?.commitment || '').toLowerCase() === 'internship',
    );
    const rows = interns.map((j) =>
      buildInternshipRow({
        title: j.text || '',
        company: name,
        link: j.hostedUrl || j.applyUrl || '',
        source: 'Lever',
        seenAt: new Date().toISOString(),
        description: extractLeverDescription(j),
      }),
    );
    const withDesc = rows.filter((r) => r.description).length;
    const sample = rows.find((r) => r.description);
    return {
      source: 'Lever',
      target: name,
      total: rows.length,
      withDesc,
      sampleDescHead: sample?.description?.slice(0, 100) ?? null,
      sampleAfterSmartTrim: sample?.description ? smartTrimDescription(sample.description).slice(0, 100) : null,
    };
  } catch (e: any) {
    console.log(`  Lever ${name}: error ${e.message}`);
    return { source: 'Lever', target: name, total: 0, withDesc: 0, sampleDescHead: null, sampleAfterSmartTrim: null };
  }
}

async function probeAshby(slug: string, name: string): Promise<Result> {
  const boardUrl = `https://jobs.ashbyhq.com/${slug}`;
  try {
    const { data: html } = await axios.get(boardUrl, {
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
      responseType: 'text',
    });
    const m = (html as string).match(/window\.__appData\s*=\s*(\{.*?\});\s*(?:\n|<\/script>|$)/s);
    if (!m) {
      console.log(`  Ashby ${name}: __appData regex missed`);
      return { source: 'Ashby', target: name, total: 0, withDesc: 0, sampleDescHead: null, sampleAfterSmartTrim: null };
    }
    const appData = JSON.parse(m[1]);
    const postings: any[] = appData?.jobBoard?.jobPostings || [];
    const interns = postings.filter((j) =>
      /\bintern(ship)?\b/i.test(j.title || '') || /\bintern(ship)?\b/i.test(j.employmentType || ''),
    );
    // Sample only first 3 to limit network calls — each posting is a separate fetch.
    const sampled = interns.slice(0, 3);
    const rows = [];
    for (const j of sampled) {
      const description = await fetchAshbyDescription(slug, j.id);
      rows.push(buildInternshipRow({
        title: j.title || '',
        company: name,
        link: `https://jobs.ashbyhq.com/${slug}/${j.id}`,
        source: 'Ashby',
        seenAt: new Date().toISOString(),
        description,
      }));
    }
    const withDesc = rows.filter((r) => r.description).length;
    const sample = rows.find((r) => r.description);
    return {
      source: 'Ashby',
      target: `${name} (sampled ${sampled.length}/${interns.length})`,
      total: rows.length,
      withDesc,
      sampleDescHead: sample?.description?.slice(0, 100) ?? null,
      sampleAfterSmartTrim: sample?.description ? smartTrimDescription(sample.description).slice(0, 100) : null,
    };
  } catch (e: any) {
    console.log(`  Ashby ${name}: error ${e.message}`);
    return { source: 'Ashby', target: name, total: 0, withDesc: 0, sampleDescHead: null, sampleAfterSmartTrim: null };
  }
}

async function probeSmartRecruiters(slug: string, name: string): Promise<Result> {
  const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?status=PUBLIC&limit=100`;
  try {
    const { data } = await axios.get(url, {
      timeout: TIMEOUT_MS,
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    const postings: any[] = data.content || [];
    const interns = postings.filter((j) =>
      /\bintern(ship)?\b/i.test(j.name || '') || /intern/i.test(j.typeOfEmployment?.id || ''),
    );
    const sampled = interns.slice(0, 3);
    const rows = [];
    for (const j of sampled) {
      const description = await fetchSmartRecruitersDescription(slug, j.id);
      rows.push(buildInternshipRow({
        title: j.name || '',
        company: name,
        link: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
        source: 'SmartRecruiters',
        seenAt: new Date().toISOString(),
        description,
      }));
    }
    const withDesc = rows.filter((r) => r.description).length;
    const sample = rows.find((r) => r.description);
    return {
      source: 'SmartRecruiters',
      target: `${name} (sampled ${sampled.length}/${interns.length})`,
      total: rows.length,
      withDesc,
      sampleDescHead: sample?.description?.slice(0, 100) ?? null,
      sampleAfterSmartTrim: sample?.description ? smartTrimDescription(sample.description).slice(0, 100) : null,
    };
  } catch (e: any) {
    console.log(`  SmartRecruiters ${name}: error ${e.message}`);
    return { source: 'SmartRecruiters', target: name, total: 0, withDesc: 0, sampleDescHead: null, sampleAfterSmartTrim: null };
  }
}

async function probeWorkday(tenant: string, board: string, wdInstance: string, name: string): Promise<Result> {
  const baseHost = `${tenant}.${wdInstance}.myworkdayjobs.com`;
  const url = `https://${baseHost}/wday/cxs/${tenant}/${board}/jobs`;
  try {
    const { data } = await axios.post(
      url,
      { appliedFacets: {}, limit: 20, offset: 0, searchText: 'intern' },
      {
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      },
    );
    const postings: any[] = data.jobPostings || [];
    const interns = postings.filter((j) => /\bintern(ship)?\b/i.test(j.title || ''));
    const sampled = interns.slice(0, 3);
    const rows = [];
    for (const j of sampled) {
      // Mimic fetchWorkdayDescription's CXS detail call inline.
      let description = '';
      try {
        const { data: detail } = await axios.get(
          `https://${baseHost}/wday/cxs/${tenant}/${board}${j.externalPath}`,
          { timeout: TIMEOUT_MS, headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } },
        );
        description = detail?.jobPostingInfo?.jobDescription || '';
      } catch { /* leave empty */ }
      rows.push(buildInternshipRow({
        title: j.title || '',
        company: name,
        link: `https://${baseHost}${j.externalPath}`,
        source: 'Workday',
        seenAt: new Date().toISOString(),
        descriptionHtml: description.slice(0, 20_000),
      }));
    }
    const withDesc = rows.filter((r) => r.description).length;
    const sample = rows.find((r) => r.description);
    return {
      source: 'Workday',
      target: `${name} (sampled ${sampled.length}/${interns.length})`,
      total: rows.length,
      withDesc,
      sampleDescHead: sample?.description?.slice(0, 100) ?? null,
      sampleAfterSmartTrim: sample?.description ? smartTrimDescription(sample.description).slice(0, 100) : null,
    };
  } catch (e: any) {
    console.log(`  Workday ${name}: error ${e.message}`);
    return { source: 'Workday', target: name, total: 0, withDesc: 0, sampleDescHead: null, sampleAfterSmartTrim: null };
  }
}

(async () => {
  console.log('\n── Greenhouse ──');
  for (const [slug, name] of [['stripe', 'Stripe'], ['databricks', 'Databricks'], ['airtable', 'Airtable'], ['scaleai', 'Scale AI'], ['brex', 'Brex']]) {
    reportRow(await probeGreenhouse(slug, name));
  }

  console.log('\n── Lever ──');
  for (const [slug, name] of [['palantir', 'Palantir'], ['mistral', 'Mistral AI']]) {
    reportRow(await probeLever(slug, name));
  }

  console.log('\n── Ashby ──');
  for (const [slug, name] of [['notion', 'Notion'], ['ramp', 'Ramp']]) {
    reportRow(await probeAshby(slug, name));
  }

  console.log('\n── SmartRecruiters ──');
  for (const [slug, name] of [['Kioxia', 'Kioxia']]) {
    reportRow(await probeSmartRecruiters(slug, name));
  }

  console.log('\n── Workday ──');
  for (const [tenant, board, instance, name] of [
    ['nvidia', 'NVIDIAExternalCareerSite', 'wd5', 'NVIDIA'],
    ['intel', 'External', 'wd1', 'Intel'],
  ]) {
    reportRow(await probeWorkday(tenant, board, instance, name));
  }
})();
