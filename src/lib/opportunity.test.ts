import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../../tests/fixtures/sigma-openings.json';
import reposts from '../../tests/fixtures/reposted-openings.json';
import doordash from '../../tests/fixtures/doordash-opening.json';
import recent from '../../tests/fixtures/recent-opening-audit.json';
import legacyEdits from '../../tests/fixtures/legacy-posting-edits.json';
import nativeMetadata from '../../tests/fixtures/native-metadata-audit.json';
import { workdayDetails } from '../poller/ats/workday';
import { greenhouseDetails } from '../poller/ats/greenhouse';
import { linkedInDetails } from '../poller/ats/linkedin';
import { leverDetails } from '../poller/ats/lever';
import { ashbyDetails } from '../poller/ats/ashby';
import { enrichForStorage } from '../poller/utils/enrich';
import { buildPosting } from '../poller/utils/build-row';
import { jobSpyPosting } from '../poller/pollers/jobspy';
import { OpportunityIndex, openingFacts, explicitInternshipTerms, roleContentSupport, employerSpelling, roleSignature, mergeIdentities, compareOpportunityAge } from './opportunity';
import type { StoredInternship, PostingIdentity } from './types';
import { detailsByUrl, postingKey } from '../poller/ats';

const gh = greenhouseDetails('sigmacomputing', fixture.greenhouse);
const li = linkedInDetails(fixture.linkedInHtml, '4476525612');
const now = '2026-10-07T02:00:00Z';
function row(id: string, identity: PostingIdentity, company: string, link = identity.sourceUrl): StoredInternship {
  return { ...enrichForStorage({ company, title: identity.title, link, locations: ['NYC'], source: identity.postingKey.split(':')[0], identity }, now), id };
}
const official = () => row('official', gh.identity!, 'Sigma Computing');
const feed = () => row('feed', li.identity!, 'Sigma');
function generic(id: string, source: string, company: string, description?: string, title = 'Software Engineer Intern (Summer 2027)'): StoredInternship {
  return { ...enrichForStorage({ company, title, link: `https://${source}.example/jobs/${id}`, locations: ['NYC'], source, description }, now), id };
}

describe('same-opening inference', () => {
  test('captured same-source reposts match the already stored opening, including same-batch copies', () => {
    for (const pair of reposts.sameSource) {
      const old = pair.old as unknown as StoredInternship;
      const incoming = pair.incoming as unknown as StoredInternship;
      assert.equal(old.source, incoming.source);
      assert.equal(new OpportunityIndex([old]).find(incoming)?.id, old.id, old.company);
      const copy = { ...incoming, id: 'another-feed-copy', identities: incoming.identities!.map(x => ({ ...x, postingKey: 'linkedin:post:9999999999' })) };
      for (const pending of [[incoming, copy], [copy, incoming]]) {
        assert.equal(new OpportunityIndex([old], pending).find(incoming)?.id, old.id, `${old.company} batch`);
      }
    }
  });

  test('captured Workday board variants bridge only through the explicit native requisition', () => {
    const c = nativeMetadata.find(c => c.name === 'marvell')!;
    const alias = c.verifiedAlias!;
    const official = row('current',workdayDetails(c.capturedRows[0].link,c.source).identity!,'Marvell');
    const duplicate = row('variant',workdayDetails(alias.externalUrl,alias).identity!,'Marvell');
    assert.notEqual(official.identities![0].postingKey,duplicate.identities![0].postingKey);
    assert.equal(official.identities![0].requisitionKey,'workday:marvell:req:2603760');
    assert.equal(duplicate.identities![0].requisitionKey,'workday:marvell:req:2603760');
    assert.equal(new OpportunityIndex([official]).find(duplicate)?.id,official.id);
    const other = row('distinct',workdayDetails(alias.externalUrl,{ ...alias,jobReqId:'99999' }).identity!,'Marvell');
    assert.equal(new OpportunityIndex([official]).find(other),undefined);
  });

  test('source ownership never erases known requisitions, requirements or hiring employers', () => {
    const board = { ...gh.identity!, origin: 'board' as const, employer: { ...gh.identity!.employer!, hiringNames: ['Beta Financial'] } };
    const weak = { ...board, origin: 'feed' as const, employer: { ...board.employer, hiringNames: [] as string[] } };
    for (const changes of [
      { requisitionKey: 'greenhouse:sigmacomputing:req:different' },
      { openingKey: 'greenhouse:sigmacomputing:internal:different' },
      { facts: { ...board.facts!, degrees: ['phd' as const] } },
      { employer: { ...board.employer, hiringNames: ['Acme Robotics'] } },
    ]) {
      const incoming = row('weak-conflict',{ ...weak,...changes },'Sigma');
      assert.equal(new OpportunityIndex([row('board',board,'Sigma')]).find(incoming),undefined,
        'known counterevidence survives source-owner resolution');
      const retained = mergeIdentities(incoming.identities!,[board]);
      assert.equal(new OpportunityIndex([{ ...incoming,identities: retained }]).find(row('candidate',board,'Sigma')),undefined,
        'merging observations cannot silently erase the same conflict');
    }
  });

  test('employer-owned metadata corrects weak labels, but feeds cannot choose between native cohorts', () => {
    const board = row('board', { ...gh.identity!, origin: 'board' }, 'Sigma');
    const future = row('future', { ...gh.identity!, origin: 'board', terms: ['summer-2028'] }, 'Sigma');
    const weak = row('weak', { ...gh.identity!, origin: 'feed', terms: ['winter-2026'],
      employer: { name: 'Sigma', kind: 'source', reference: gh.identity!.sourceUrl } }, 'Sigma');
    assert.equal(new OpportunityIndex([board]).find(weak)?.id, board.id, 'same physical posting owns aggregator labels');
    assert.equal(new OpportunityIndex([board,future]).find(weak), undefined, 'contradictory native cohorts need fresh proof');
    assert.equal(new OpportunityIndex([board]).find(future), undefined);
  });

  test('captured same-post title edits keep one opening without relying on title synonyms', () => {
    for (const pair of [legacyEdits.slice(0, 2), legacyEdits.slice(2, 4)]) {
      const rows = pair.map(r => ({ ...generic(r.id, r.source, r.company), ...r,
        firstSeenAt: r.first_seen_at, identities: r.identities.length ? r.identities as PostingIdentity[] : [{
          postingKey: postingKey(r.link), sourceUrl: r.link, title: r.title,
          terms: explicitInternshipTerms(r.title, r.description), facts: openingFacts(r.description),
        }] }));
      assert.equal(new OpportunityIndex([rows[0]]).find(rows[1])?.id, rows[0].id, pair[0].company);
      assert.equal(new OpportunityIndex([rows[1]]).find(rows[0])?.id, rows[1].id, `${pair[0].company} reverse`);
      const nextYear = { ...rows[1], identities: rows[1].identities.map(x => ({ ...x, terms: ['summer-2028'] })) };
      if (rows[0].identities[0].terms.length) assert.equal(new OpportunityIndex([rows[0]]).find(nextYear), undefined);
    }
  });

  test('a recruiting profile cannot join explicitly different hiring employers', () => {
    const jd = 'Responsibilities:\nBuild production software and collaborate with engineers on reliable distributed systems, implement new features, improve testing infrastructure and maintain automated integration workflows.';
    const make = (id: string, employer: string) => row(id, linkedInDetails(`<h2>Software Engineer Intern (Summer 2027)</h2><a data-tracking-control-name="public_jobs_topcard-org-name" href="https://www.linkedin.com/company/recruiting-agency">Agency</a><div class="show-more-less-html__markup"><p>${jd}</p><p>${employer} is an equal opportunity employer.</p></div>`, id).identity!, 'Recruiting Agency');
    assert.equal(new OpportunityIndex([make('1', 'Acme Robotics')]).find(make('2', 'Beta Financial')), undefined);
    assert.equal(new OpportunityIndex([make('1', 'Acme Robotics')]).find(make('3', 'Acme Robotics'))?.id, '1');
  });

  test('audited recent same-posting duplicates recognize source URL aliases and abbreviated titles', () => {
    for (const c of recent.duplicateCases.filter(c => 'greenhouse' in c)) {
      const pair = c.capturedRows.map(r => ({ ...generic(r.id, r.source, r.company), ...r,
        identities: r.identities as PostingIdentity[], firstSeenAt: r.first_seen_at }));
      assert.equal(new OpportunityIndex([pair[0]]).find(pair[1])?.id, pair[0].id, c.name);
      assert.equal(new OpportunityIndex([pair[1]]).find(pair[0])?.id, pair[1].id, `${c.name} reverse`);
    }
  });

  test('audited employer job IDs and explicit hiring-employer statements bridge Amazon copies', async () => {
    for (const c of recent.duplicateCases.filter(c => 'linkedin' in c)) {
      const feeds = c.linkedin!.map(j => {
        const f = j.fields;
        const html = `<h2>${f.title}</h2><a data-tracking-control-name="public_jobs_topcard-org-name" href="${f.employerAnchor.href}">${f.employerAnchor.text}</a><div class="show-more-less-html__markup">${f.descriptionHtml}</div>`;
        return row(j.jobId, linkedInDetails(html, j.jobId).identity!, 'Amazon');
      });
      assert.equal(new OpportunityIndex([feeds[0]]).find(feeds[1])?.id, feeds[0].id, c.name);
      if (c.name.startsWith('amazon-leo')) {
        const direct = c.capturedRows[0];
        const details = await detailsByUrl(direct.link);
        const known = enrichForStorage({ company: direct.company, title: direct.title, link: direct.link,
          source: direct.source, locations: [], identity: details.identity }, now);
        assert.equal(feeds[0].identities?.[0].requisitionKey, 'amazon:amazon:req:10571374');
        assert.equal(new OpportunityIndex([known, generic('other-amazon-role', 'feed-a', 'Amazon')]).find(feeds[0])?.id, known.id,
          'explicit requisition evidence wins over broad generic/named-role ambiguity');
      }
    }
  });

  test('audited different seasons, placeholder requisitions and distinct internship durations stay separate', () => {
    for (const c of recent.deliberatelySeparateCases) {
      let observations: StoredInternship[];
      if ('greenhouse' in c) observations = c.greenhouse!.map((j, n) => row(`${c.name}-${n}`, greenhouseDetails(j.boardSlug, j.job).identity!, 'Example'));
      else observations = c.linkedin.map(j => row(j.jobId, linkedInDetails(`<h2>${j.fields.title}</h2><a data-tracking-control-name="public_jobs_topcard-org-name" href="${j.fields.employerAnchor.href}">${j.fields.employerAnchor.text}</a><div class="show-more-less-html__markup">${j.fields.descriptionHtml}</div>`, j.jobId).identity!, 'Docusign'));
      assert.equal(new OpportunityIndex([observations[0]]).find(observations[1]), undefined, c.name);
    }
  });

  test('unqualified Greenhouse IDs never bridge different employer application URLs or erase conflicting qualified evidence', () => {
    const a = official();
    const unrelated = row('other', { ...gh.identity!, postingKey: gh.identity!.postingKey.replace('sigmacomputing', '_'),
      sourceUrl: 'https://unrelated.example/careers?gh_jid=7850795003', employer: { name: 'Other Company', reference: 'https://unrelated.example', kind: 'source' },
      openingKey: undefined, requisitionKey: undefined }, 'Other Company');
    assert.equal(new OpportunityIndex([a]).find(unrelated), undefined);
    const unknown = row('unknown', { ...unrelated.identities![0], sourceUrl: 'https://first.example/careers?gh_jid=7850795003' }, 'First Company');
    assert.equal(new OpportunityIndex([unknown]).find(unrelated), undefined, 'tenantless IDs are never global posting identities');
    const contradiction = row('other', { ...gh.identity!, postingKey: gh.identity!.postingKey, terms: ['summer-2028'] }, 'Sigma');
    assert.equal(new OpportunityIndex([a]).find(contradiction), undefined, 'authoritative season conflicts still veto a reused ID');
    for (const changes of [
      { requisitionKey: 'greenhouse:sigmacomputing:req:different' },
      { openingKey: 'greenhouse:sigmacomputing:internal:different' },
      { facts: { ...gh.identity!.facts!, degrees: ['phd' as const] } },
      { facts: { ...gh.identity!.facts!, durationWeeks: [16] } },
    ]) {
      const keep = { ...a, identities: a.identities!.map(x => ({ ...x, facts: { ...x.facts!, durationWeeks: [12] } })) };
      assert.equal(new OpportunityIndex([keep]).find(row('counterevidence', { ...gh.identity!, title: 'Edited role label', ...changes }, 'Sigma')), undefined,
        'same-post label changes never erase known opening, requisition, degree or duration conflicts');
    }
  });

  test('captured DoorDash history recognizes new feed IDs after its canonical was archived', () => {
    const captured = (id: string): StoredInternship => {
      const r = doordash.history.find(r => r.id === id)!;
      return { ...enrichForStorage({ company: r.company, title: r.title, link: r.link,
        source: r.source, locations: r.locations }, now), ...r, firstSeenAt: r.first_seen_at,
        archiveReason: r.archive_reason ?? undefined, identities: r.identities as PostingIdentity[] };
    };
    const canonical = captured('55a303cad8fc61eb1806587baa835d59');
    const absorbed = captured('0d297bfe3e471ce4ce90c15fe1732f23');
    const incoming = captured('304ed301936487a9c521bee16c459e6c');
    const official = row('fresh-official', greenhouseDetails('doordashusa', doordash.greenhouse).identity!, 'DoorDash');
    for (const pending of [[incoming, official], [official, incoming]]) {
      assert.equal(new OpportunityIndex([canonical, absorbed], pending).find(incoming)?.id, canonical.id);
    }
    assert.equal(new OpportunityIndex([{ ...canonical, archived: false }]).find(incoming)?.id, canonical.id,
      'accepted generic and Labs titles are observations of one opening, not competing roles');
  });

  test('archived history needs positive content evidence, not just a matching role and season', () => {
    const archived = { ...generic('old', 'feed-a', 'Example'), archived: true };
    assert.equal(new OpportunityIndex([archived]).find(generic('new', 'feed-b', 'Example')), undefined);
    const description = 'Responsibilities:\nBuild production software and collaborate with engineers on reliable distributed systems, implement new features, improve testing infrastructure and maintain automated integration workflows.';
    const old = { ...generic('old', 'feed-a', 'Example', description), archived: true };
    assert.equal(new OpportunityIndex([old]).find(generic('new', 'feed-b', 'Example', description))?.id, old.id);
    assert.equal(new OpportunityIndex([old]).find(generic('future', 'feed-b', 'Example', description, 'Software Engineer Intern (Summer 2028)')), undefined);
  });

  test('a retained generic title can refine to one named role, but cannot choose between other named roles', () => {
    const common = 'Responsibilities:\nBuild production software and collaborate with engineers on reliable distributed systems, implement new features, improve testing infrastructure and maintain automated integration workflows.';
    const named = generic('old', 'feed-a', 'Example', common, 'Software Engineer Intern (Backend) (Summer 2027)');
    named.identities = [...named.identities!, ...generic('legacy', 'feed-a', 'Example', common).identities!];
    const backend = generic('new', 'feed-b', 'Example', common, 'Software Engineer Intern (Backend) (Summer 2027)');
    assert.equal(new OpportunityIndex([named]).find(backend)?.id, named.id);
    const frontend = generic('frontend', 'feed-c', 'Example', common, 'Software Engineer Intern (Frontend) (Summer 2027)');
    assert.equal(new OpportunityIndex([named]).find(frontend), undefined);
    assert.equal(new OpportunityIndex([named, frontend]).find(generic('unknown', 'feed-d', 'Example', common)), undefined);
    assert.equal(new OpportunityIndex([named, generic('competitor', 'feed-c', 'Example', common)]).find(backend), undefined,
      'a separate generic posting remains a competitor');
  });

  test('copy grouping requires every pair to be corroborated, not a transitive similarity bridge', () => {
    const facts = (tokens: string[]) => ({ version: 1 as const, roleTokens: tokens, degrees: [], teams: [], technologies: [] });
    const common = Array.from({ length: 8 }, (_, n) => `common${n}`);
    const first = [...common, ...Array.from({ length: 4 }, (_, n) => `left${n}`)];
    const third = Array.from({ length: 12 }, (_, n) => `right${n}`);
    const middle = [...first, ...third];
    const a = generic('a', 'feed-a', 'Example'), b = generic('b', 'feed-b', 'Example'), c = generic('c', 'feed-c', 'Example');
    a.identities![0].facts = facts(first); b.identities![0].facts = facts(middle); c.identities![0].facts = facts(third);
    assert.equal(roleContentSupport(a.identities![0].facts, b.identities![0].facts), 'supports');
    assert.equal(roleContentSupport(b.identities![0].facts, c.identities![0].facts), 'supports');
    assert.equal(roleContentSupport(a.identities![0].facts, c.identities![0].facts), 'unknown');
    for (const pending of [[a, b, c], [c, b, a]]) assert.equal(new OpportunityIndex([a, b, c], pending).find(generic('new', 'feed-d', 'Example')), undefined);
    c.identities![0].facts = undefined;
    assert.equal(new OpportunityIndex([a, c]).find(generic('new', 'feed-d', 'Example')), undefined, 'missing details still represent ambiguity');
  });

  test('incoming and retained observations cannot bridge unsupported roles through ingestion or cleanup', () => {
    const left = Array.from({ length: 12 }, (_, n) => `left${n}`).join(' ');
    const right = Array.from({ length: 12 }, (_, n) => `right${n}`).join(' ');
    const make = (id: string, content: string) => generic(id, 'Linkedin', 'Bridge Example', `Responsibilities:\n${content}`, 'Software Engineer Intern');
    const a = make('a', left), b = make('b', `${left} ${right}`), c = make('c', right);
    assert.deepEqual(a.identities![0].terms, []);
    const index = new OpportunityIndex([a], [b, c]);
    assert.equal(index.find(b), undefined);
    index.add(b);
    assert.equal(index.find(c), undefined, 'incoming C is part of the clique, not just A and B');
    index.add(c);
    for (const candidate of [a, b, c]) assert.equal(index.find(candidate), undefined, 'cleanup cannot borrow B to bridge A and C');
    const combined = { ...a, identities: mergeIdentities(a.identities!, b.identities!) };
    assert.equal(new OpportunityIndex([combined]).find(c), undefined, 'all retained substantive aliases must corroborate a content-only match');
    const bc = { ...b, identities: mergeIdentities(b.identities!, c.identities!) };
    assert.equal(new OpportunityIndex([bc]).find(a), undefined, 'a previously folded B/C cannot absorb A');
  });

  test('JobSpy preserves actual employer spelling even when detail lookup is unavailable', () => {
    const raw = jobSpyPosting({ company: 'Example (Robotics)', title: 'Software Engineer Intern (Summer 2027)', source: 'Linkedin', link: 'https://www.linkedin.com/jobs/view/123', location: 'NYC', postedAt: now }, now);
    assert.equal(raw.companyObserved, true);
    assert.equal(enrichForStorage(raw, now).identities?.[0].employer?.name, 'Example (Robotics)');
    assert.equal(jobSpyPosting({ ...raw, company: ' ', location: 'NYC', postedAt: now }, now).companyObserved, false);
  });

  test('actual Sigma sources retain qualified opening evidence without requiring identical descriptions', () => {
    assert.equal(gh.description.length, 6000);
    assert.equal(li.description.length, 6000);
    assert.equal(gh.identity?.openingKey, 'greenhouse:sigmacomputing:internal:5816425003');
    assert.equal(gh.identity?.requisitionKey, 'greenhouse:sigmacomputing:req:809');
    assert.equal(gh.identity?.employer?.name, 'Sigma Computing');
    assert.equal(li.identity?.employer?.name, 'sigmacomputing');
    assert.equal(roleContentSupport(gh.identity?.facts, li.identity?.facts), 'supports');
    assert.ok(!fixture.linkedInHtml.includes('sigmacomputing.com'));
    assert.equal(new OpportunityIndex([official()]).find(feed())?.id, 'official');
  });

  test('a harmless heading edit, omitted boilerplate and shortened/reworded duties still merge', () => {
    const edited = linkedInDetails(fixture.linkedInHtml.replace('Our Internship Program At Sigma', 'Our Student Engineering Program'), '4476525612');
    assert.equal(new OpportunityIndex([official()]).find(row('edited', edited.identity!, 'Sigma'))?.id, 'official');
    const shortened = { ...li.identity!, facts: openingFacts('About the role:\nShip analytics features with an engineering mentor. Build scalable backend services, user interfaces and automated tests.\nRequirements:\nMust be pursuing a Bachelor degree.') };
    assert.equal(new OpportunityIndex([official()]).find(row('shortened', shortened, 'Sigma'))?.id, 'official');
    const noBoilerplate = { ...li.identity!, facts: openingFacts('About the role:\n' + gh.description.split(/About the role:/i)[1]?.split(/About us:/i)[0]) };
    assert.equal(new OpportunityIndex([official()]).find(row('no-boilerplate', noBoilerplate, 'Sigma'))?.id, 'official');
  });

  test('agreed singleton policy can infer without descriptions, but not from defaults or a bare year', () => {
    const first = generic('first', 'feed-a', 'Example Labs');
    assert.equal(new OpportunityIndex([first]).find(generic('later', 'feed-b', 'Example Labs'))?.id, 'first');
    for (const title of ['Software Engineer Intern', 'Software Engineer Intern 2027']) {
      assert.equal(new OpportunityIndex([generic('first', 'feed-a', 'Example Labs', undefined, title)])
        .find(generic('later', 'feed-b', 'Example Labs', undefined, title)), undefined);
    }
    assert.equal(new OpportunityIndex([first]).find(generic('different-year', 'feed-b', 'Example Labs', undefined, 'Software Engineer Intern (Summer 2028)')), undefined);
  });

  test('substantive responsibilities can corroborate when one title omits the term', () => {
    const incoming = { ...li.identity!, title: 'Software Engineer Intern', terms: [] };
    assert.equal(new OpportunityIndex([official()]).find(row('no-term', incoming, 'Sigma'))?.id, 'official');
    assert.equal(new OpportunityIndex([official()]).find(row('no-term', { ...incoming, facts: undefined }, 'Sigma')), undefined);
  });

  test('an ordinary lexical similarity miss is unknown, not a veto', () => {
    const left = openingFacts('Responsibilities:\nImplement reliable visualization dashboards using efficient browser rendering techniques and optimized client interactions across multiple product surfaces.');
    const right = openingFacts('Responsibilities:\nDeliver polished charts within interactive web applications, improve painting latency, manage event handlers, build accessibility controls and responsive layouts.');
    assert.equal(roleContentSupport(left, right), 'unknown');
    assert.equal(new OpportunityIndex([generic('a', 'feed-a', 'Example', 'Responsibilities:\nImplement reliable visualization dashboards using efficient browser rendering techniques and optimized client interactions across multiple product surfaces.')])
      .find(generic('b', 'feed-b', 'Example', 'Responsibilities:\nDeliver polished charts within interactive web applications, improve painting latency, manage event handlers, build accessibility controls and responsive layouts.'))?.id, 'a');
  });

  test('requirements-only descriptions retain explicit programming-language conflicts', () => {
    const cpp = generic('a', 'feed-a', 'Example', 'Requirements:\nMust be proficient in C++.');
    const cs = generic('b', 'feed-b', 'Example', 'Requirements:\nMust be proficient in C#.');
    assert.deepEqual(cpp.identities?.[0].facts?.technologies, ['c++']);
    assert.deepEqual(cs.identities?.[0].facts?.technologies, ['c#']);
    assert.equal(new OpportunityIndex([cpp]).find(cs), undefined);
  });

  test('partial rediscovery cannot erase retained eligibility, team or technology constraints', () => {
    const old = generic('a', 'feed-a', 'Example', 'Responsibilities:\nBuild production software using C++.\nRequirements:\nMust be enrolled in a Bachelor program.\nTeam: Analytics');
    const partial = generic('a', 'feed-a', 'Example', 'Responsibilities:\nBuild production software.');
    const updated = { ...old, identities: mergeIdentities(old.identities!, partial.identities!) };
    assert.deepEqual(updated.identities[0].facts?.degrees, ['bs']);
    assert.deepEqual(updated.identities[0].facts?.teams, ['analytics']);
    assert.deepEqual(updated.identities[0].facts?.technologies, ['c++']);
    const phd = generic('b', 'feed-b', 'Example', 'Responsibilities:\nBuild production software.\nRequirements:\nPh.D. required.');
    assert.equal(new OpportunityIndex([old]).find(phd), undefined);
    assert.equal(new OpportunityIndex([updated]).find(phd), undefined);
  });

  test('generic intern titles cannot hide competing roles or supply a qualified-role match', () => {
    const genericRole = generic('a', 'feed-a', 'Example', undefined, 'Intern (Summer 2027)');
    const specific = generic('b', 'feed-b', 'Example');
    const incoming = generic('c', 'feed-c', 'Example', undefined, 'Intern (Summer 2027)');
    assert.equal(roleSignature(incoming.title), '');
    assert.equal(new OpportunityIndex([genericRole, specific]).find(incoming), undefined);
    assert.equal(new OpportunityIndex([genericRole]).find(incoming), undefined, 'an unknown role is not positive role evidence');
    for (const pending of [[genericRole, specific, incoming], [incoming, genericRole, specific]]) {
      assert.equal(new OpportunityIndex([genericRole], pending).find(incoming), undefined);
    }
  });

  test('different responsibilities and programming-language constraints are counterevidence', () => {
    const a = 'Responsibilities:\nDesign spacecraft firmware telemetry navigation propulsion actuators embedded microcontrollers flight sensors hardware electronics avionics radio communication guidance thrusters orbital simulation radiation qualification satellite power payload integration.';
    const b = 'Responsibilities:\nCreate storefront checkout inventory pricing promotions payments coupons shopping cart catalog search merchandising retail recommendations fraud transactions invoicing shipping discounts warehouse fulfillment customer subscription billing.';
    assert.equal(roleContentSupport(openingFacts(a), openingFacts(b)), 'contradicts');
    assert.equal(new OpportunityIndex([generic('a', 'feed-a', 'Example', a)]).find(generic('b', 'feed-b', 'Example', b)), undefined);
    const common = 'Responsibilities:\nBuild production software and collaborate with engineers on reliable distributed systems, implement new features, improve testing infrastructure and maintain automated integration workflows.\n';
    assert.equal(new OpportunityIndex([generic('a', 'feed-a', 'Example', common + 'Use C++ for this work.')])
      .find(generic('b', 'feed-b', 'Example', common + 'Use C# for this work.')), undefined);
  });

  test('mandatory degree/team evidence survives the 6000-character cap; preferences do not become requirements', () => {
    const prefix = 'Responsibilities:\nBuild production software and collaborate with engineers on reliable systems.\n' + 'Additional project information. '.repeat(250);
    const undergrad = buildPosting({ company: 'Example', companyObserved: true, title: 'Software Engineer Intern (Summer 2027)', source: 'feed-a', link: 'https://feed-a.example/a', now,
      description: prefix + '\nRequirements:\nMust be enrolled in an undergraduate program.\nTeam: Visualizations' });
    const phd = buildPosting({ ...undergrad, now, source: 'feed-b', link: 'https://feed-b.example/b', description: prefix + '\nRequirements:\nPh.D. required.\nTeam: Visualizations' });
    assert.equal(undergrad.description?.length, 6000);
    assert.deepEqual(undergrad.openingFacts?.degrees, ['bs']);
    assert.deepEqual(phd.openingFacts?.degrees, ['phd']);
    assert.equal(new OpportunityIndex([enrichForStorage(undergrad, now)]).find(enrichForStorage(phd, now)), undefined);
    assert.deepEqual(openingFacts('Requirements:\nMust be enrolled in a Bachelor program.\nPhD preferred.')?.degrees, ['bs']);
    assert.deepEqual(openingFacts('Requirements:\nBachelor degree required.\nMust be enrolled in a graduate program.')?.degrees, ['ms', 'phd']);
    assert.deepEqual(openingFacts('Requirements:\nBachelor degree required.\nPh.D. required.')?.degrees, ['phd']);
    assert.equal(new OpportunityIndex([generic('a', 'feed-a', 'Example', 'Responsibilities:\nTeam: Payments')])
      .find(generic('b', 'feed-b', 'Example', 'Responsibilities:\nTeam: Search')), undefined);
  });

  test('raw employer spelling is independent of display aliases and configured ATS slugs', () => {
    const a = generic('a', 'feed-a', 'Acme (Robotics)');
    const b = generic('b', 'feed-b', 'Acme (Finance)');
    assert.equal(a.company, b.company, 'display canonicalization deliberately collapses these labels');
    assert.equal(a.identities?.[0].employer?.name, 'Acme (Robotics)');
    assert.equal(new OpportunityIndex([a]).find(b), undefined);
    assert.notEqual(employerSpelling('Acme Labs'), employerSpelling('Acme'));
    const configured = buildPosting({ title: a.title, company: 'Acme (Robotics)', source: 'Lever', link: 'https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111', now });
    assert.equal(enrichForStorage(configured, now).identities?.[0].employer, undefined);
    assert.equal(new OpportunityIndex([a]).find(enrichForStorage(configured, now)), undefined);
  });

  test('different public Greenhouse posts sharing an underlying job remain one opening', () => {
    const second = greenhouseDetails('sigmacomputing', { ...fixture.greenhouse, id: 8001295003 });
    assert.equal(new OpportunityIndex([official()]).find(row('nyc', second.identity!, 'Sigma Computing'))?.id, 'official');
    const reqOnly = { ...second.identity!, openingKey: undefined };
    assert.equal(new OpportunityIndex([official(), row('nyc', reqOnly, 'Sigma Computing')]).find(feed())?.id, 'nyc');
  });

  test('known opening IDs can fill a missing team qualifier but cannot override conflicting named teams', () => {
    const named = { ...gh.identity!, postingKey: 'greenhouse:sigmacomputing:post:8001295003', title: 'Software Engineer Intern (Backend)' };
    assert.equal(new OpportunityIndex([official()]).find(row('named', named, 'Sigma Computing'))?.id, 'official');
    const frontend = { ...named, title: 'Software Engineer Intern (Frontend)', postingKey: 'greenhouse:sigmacomputing:post:999' };
    assert.equal(new OpportunityIndex([row('named', named, 'Sigma Computing')]).find(row('frontend', frontend, 'Sigma Computing')), undefined);
  });

  test('known different requisitions veto inference even with the same employer, role and term', () => {
    for (const changes of [{ internal_job_id: 99 }, { internal_job_id: undefined, requisition_id: '999' }]) {
      const other = greenhouseDetails('sigmacomputing', { ...fixture.greenhouse, id: 999, ...changes });
      assert.equal(new OpportunityIndex([official()]).find(row('other', other.identity!, 'Sigma Computing')), undefined);
    }
  });

  test('ambiguity includes missing-term competitors with different descriptions across ATS kinds and batch orders', () => {
    for (const kind of ['greenhouse', 'lever', 'ashby', 'workday', 'workable', 'rippling', 'smartrecruiters', 'icims']) {
      const known = { ...gh.identity!, postingKey: `${kind}:example:post:1`, openingKey: undefined, requisitionKey: undefined };
      const unknown = { ...known, postingKey: `${kind}:example:post:2`, terms: [], facts: openingFacts('Responsibilities:\nHelp engineers deliver thoughtful product improvements.') };
      const a = row('a', known, 'Sigma Computing'), b = row('b', unknown, 'Sigma Computing');
      for (const pending of [[feed(), a, b], [b, a, feed()], [a, feed(), b]]) {
        assert.equal(new OpportunityIndex([a, b], pending).find(feed()), undefined, kind);
        assert.equal(new OpportunityIndex([feed()], pending).find(a), undefined, `${kind} reverse arrival`);
      }
    }
  });

  test('a generic title cannot choose between named teams and location suffixes retain team words', () => {
    assert.notEqual(roleSignature('Software Engineer Intern, NYC - Backend'), roleSignature('Software Engineer Intern, NYC - Frontend'));
    const a = { ...gh.identity!, title: 'Software Engineer Intern, NYC - Backend' };
    const b = { ...gh.identity!, title: 'Software Engineer Intern, NYC - Frontend', postingKey: 'greenhouse:sigmacomputing:post:999', openingKey: undefined, requisitionKey: undefined };
    assert.equal(new OpportunityIndex([row('a', a, 'Sigma Computing'), row('b', b, 'Sigma Computing')]).find(feed()), undefined);
  });

  test('bare years, graduation years and conversion dates are not explicit internship matching terms', () => {
    assert.deepEqual(explicitInternshipTerms('Software Engineer Intern', 'Must graduate in 2028. Start full-time in Summer 2028.'), []);
    assert.deepEqual(explicitInternshipTerms('Software Engineer Intern', 'Internship program runs Summer 2027.\nMust graduate in 2028.'), ['summer-2027']);
    assert.deepEqual(explicitInternshipTerms('Software Engineering Intern (Summer 2028)', 'Our Summer 2027 program'), ['summer-2028']);
    assert.deepEqual(openingFacts('We offer excellent company benefits and flexible vacation.')?.roleTokens, []);
    assert.equal(roleContentSupport(openingFacts('We offer excellent company benefits.'), gh.identity?.facts), 'unknown');
  });

  test('source parsers preserve non-GH role/eligibility evidence before caps without inventing employers', () => {
    const description = 'Responsibilities:\nBuild reliable software.\n' + 'Company information. '.repeat(400) + '\nRequirements:\nMust be enrolled in a Master program.';
    const lever = leverDetails('configured-slug', '11111111-1111-1111-1111-111111111111', { text: 'Software Engineer Intern (Summer 2027)', descriptionPlain: description });
    const ashby = ashbyDetails('configured-slug', { id: '11111111-1111-1111-1111-111111111111', title: lever.identity!.title, descriptionPlain: description });
    for (const d of [lever, ashby]) {
      assert.equal(d.description.length, 6000);
      assert.deepEqual(d.identity?.facts?.degrees, ['ms']);
      assert.equal(d.identity?.employer, undefined);
    }
  });

  test('rediscovery retains the canonical requisition veto against another opening', () => {
    const canonical = { ...feed(), identities: [li.identity!, gh.identity!] };
    const other = row('different-req', { ...gh.identity!, postingKey: 'greenhouse:sigmacomputing:post:999', openingKey: 'greenhouse:sigmacomputing:internal:99', requisitionKey: 'greenhouse:sigmacomputing:req:999' }, 'Sigma Computing');
    assert.equal(new OpportunityIndex([canonical, other]).find(feed()), undefined);
  });

  test('canonical age preserves microseconds and compares mixed ISO precision', () => {
    const early = { ...official(), id: 'z-first', firstSeenAt: '2026-10-07T01:01:01.123100Z' };
    const later = { ...feed(), id: 'a-later', firstSeenAt: '2026-10-07T01:01:01.123900Z' };
    assert.ok(compareOpportunityAge(early, later) < 0);
    assert.ok(compareOpportunityAge({ ...early, firstSeenAt: '2026-10-07T01:01:01.123Z' }, early) < 0);
    assert.equal(compareOpportunityAge({ ...early, firstSeenAt: '2026-10-07T01:01:01.1231Z' }, early), 0);
  });

  test('rediscovery updates an observation without deleting retained facts or accepted aliases', () => {
    const combined = mergeIdentities([li.identity!], [gh.identity!]);
    const updated = mergeIdentities(combined, [{ ...gh.identity!, facts: undefined, employer: undefined }]);
    assert.equal(updated.length, 2);
    assert.deepEqual(updated.find(x => x.postingKey === gh.identity!.postingKey)?.facts, gh.identity?.facts);
    assert.equal(updated.find(x => x.postingKey === li.identity!.postingKey)?.employer?.name, 'sigmacomputing');
  });
});
