import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sameDayCase as fixture, observeLinkedIn as observe } from '../../tests/helpers/same-day-openings';
import { OpportunityIndex, openingFacts, explicitInternshipTerms, roleSignature, statedRequisitionReference } from './opportunity';
import { hasCurrentIdentity } from '../poller/identity';
import { enrichForStorage } from '../poller/utils/enrich';
import { mergeIdentities } from './opportunity';

describe('captured same-day opportunity neighborhoods', () => {
  test('Neuralink copies reach their native opening despite archived generic history, in either batch order', () => {
    const rows = fixture('neuralink-internal-apps');
    const incoming = rows.slice(1, 3).map(observe);
    const history = rows.filter(r => !incoming.some(i => i.id === r.id));
    for (const pending of [incoming, [...incoming].reverse()]) {
      const index = new OpportunityIndex(history, pending);
      for (const r of pending) assert.equal(index.find(r)?.id, rows[0].id);
    }
    const index = new OpportunityIndex([...history, ...incoming]);
    for (const r of incoming) assert.equal(index.find(r)?.id, rows[0].id, 'cleanup uses the same neighborhood proof');
  });

  test('Databricks location copies select their employer-scoped requisition, without combining cohorts', () => {
    const rows = fixture('databricks-winter-and-general');
    const history = [rows[0], rows[3]];
    const incoming = [rows[1], rows[2], rows[4], rows[5]].map(observe);
    for (const pending of [incoming, [...incoming].reverse()]) {
      const index = new OpportunityIndex(history, pending);
      for (const r of pending) assert.equal(index.find(r)?.id, r.title.includes('Winter') ? rows[0].id : rows[3].id);
    }
    assert.equal(incoming[0].identities![0].requisitionReference, 'p-1588');
    assert.deepEqual(incoming[0].identities![0].terms, ['winter-2027']);
    assert.equal(incoming[2].identities![0].requisitionReference, 'p-963');
  });

  test('Valon responsibilities survive a leading company introduction and support both city observations', () => {
    const rows = fixture('valon-company-intro-truncation');
    assert.equal(rows[0].identities![0].facts!.roleTokens.length, 0, 'captured broken extraction');
    const current = rows.map(observe);
    assert.ok(current[0].identities![0].facts!.roleTokens.length >= 100);
    const index = new OpportunityIndex(current);
    assert.equal(index.find(current[0])?.id, current[1].id);
    assert.equal(index.find(current[1])?.id, current[0].id);
    assert.ok(!current[0].identities![0].facts!.roleTokens.includes('mortgage'), 'company introduction is not role content');
  });

  test('Meta generic copies are not vetoed by unrelated or ineligible PhD roles', () => {
    const rows = fixture('meta-identical-seattle-feed-copies');
    const current = rows.slice(0, 2).map(observe);
    const index = new OpportunityIndex([...rows.slice(2), ...current]);
    assert.equal(index.find(current[0])?.id, current[1].id);
    assert.equal(index.find(current[1])?.id, current[0].id);
  });

  test('IBM observed city suffixes do not become team qualifiers or let unrelated teams veto copies', () => {
    const rows = fixture('ibm-same-description-location-copies');
    const current = rows.slice(0, 2).map(observe);
    const index = new OpportunityIndex([...rows.slice(2), ...current]);
    const allowed = new Set([current[1].id, ...rows.slice(3).map(r => r.id)]);
    assert.ok(allowed.has(index.find(current[0])!.id));
    assert.equal(roleSignature('Software Developer Intern 2027 - Cambridge', ['Cambridge, MA, USA']), 'software developer');
    assert.notEqual(roleSignature('Software Developer Intern - Internal Apps', ['Cambridge, MA, USA']), 'software developer');
  });

  test('observed city suffixes cannot hide a competing named role with corroborating duties', () => {
    const description = 'Responsibilities:\nBuild reliable production software, implement distributed systems and automated tests, collaborate with engineers, improve database performance and ship useful user-facing features.';
    const make = (id: string, title: string) => ({ ...enrichForStorage({ company: 'City Example', companyObserved: true,
      title, source: 'Linkedin', link: `https://feed.example/${id}`, locations: ['Cambridge, MA'], description, season: ['summer-2027'],
    }, '2026-10-19T12:00:00Z'), id });
    const generic = make('generic', 'Software Engineer Intern');
    const platform = make('platform', 'Software Engineer Intern - Platform');
    for (const title of ['Software Engineer Intern', 'Software Engineer Intern - Cambridge']) {
      assert.equal(new OpportunityIndex([generic, platform]).find(make('incoming', title)), undefined);
    }
    assert.equal(roleSignature('Mobile Software Engineer Intern', ['Mobile, AL']), 'mobile software engineer');
    assert.equal(roleSignature('Commerce Software Engineer Intern', ['Commerce, CA']), 'commerce software engineer');
  });

  test('a weak feed cannot be borrowed by either of two known openings, even across different terms', () => {
    const description = 'Responsibilities:\nBuild reliable production software, implement distributed systems and automated tests, collaborate with engineers, improve database performance and ship useful user-facing features.';
    const make = (id: string) => ({ ...enrichForStorage({ company: 'Bridge Example', companyObserved: true,
      title: 'Software Engineer Intern', source: 'Linkedin', link: `https://feed.example/${id}`, locations: ['NYC'], description,
    }, '2026-10-19T12:00:00Z'), id });
    const weak = make('weak'), winter = make('winter'), summer = make('summer');
    winter.identities = winter.identities!.map(x => ({ ...x, origin: 'board', postingKey: 'greenhouse:bridge:post:1',
      openingKey: 'greenhouse:bridge:internal:1', requisitionKey: 'greenhouse:bridge:req:1', terms: ['winter-2027'] }));
    summer.identities = summer.identities!.map(x => ({ ...x, origin: 'board', postingKey: 'greenhouse:bridge:post:2',
      openingKey: 'greenhouse:bridge:internal:2', requisitionKey: 'greenhouse:bridge:req:2', terms: ['summer-2027'] }));
    for (const pending of [[winter, summer], [summer, winter]]) {
      const index = new OpportunityIndex([weak], pending);
      for (const r of pending) assert.equal(index.find(r), undefined);
    }
  });

  test('a display company alias alone does not invent source employer ownership', () => {
    const rows = fixture('tenstorrent-employer-evidence-mismatch');
    assert.equal(new OpportunityIndex(rows).find(rows[1]), undefined, 'unproven source-employer relationship remains unresolved');
  });

  test('Astranis cohorts and MORSE degree requirements remain separate despite shared native IDs', () => {
    for (const name of ['astranis-cohorts-share-ids', 'morse-graduate-and-undergraduate-share-ids']) {
      const rows = fixture(name);
      const index = new OpportunityIndex(rows);
      for (const r of rows) assert.equal(index.find(r), undefined, `${name}: ${r.title}`);
    }
  });
});

describe('source evidence for candidate selection', () => {
  test('literal references require a unique source statement and never invent a qualified key', () => {
    assert.equal(statedRequisitionReference('P-1588\n\nResponsibilities: build software.'), 'p-1588');
    assert.equal(statedRequisitionReference('Requisition ID: ABC-123\nResponsibilities: build software.'), 'abc-123');
    assert.equal(statedRequisitionReference('Use P-1588 when contacting customer support.'), undefined);
    assert.equal(statedRequisitionReference('P-1588\nP-963'), undefined);
    assert.equal(statedRequisitionReference('Job ID: 123456'), undefined, 'a public posting ID is not necessarily an employer requisition');
    assert.equal(statedRequisitionReference('Requisition ID: TBD'), undefined);
    assert.equal(statedRequisitionReference('Requisition ID: 000'), undefined);
    const r = observe(fixture('databricks-winter-and-general')[1]);
    assert.equal(r.identities![0].requisitionKey, undefined);
    assert.ok(hasCurrentIdentity(r.identities![0]));
    assert.equal(hasCurrentIdentity(fixture('databricks-winter-and-general')[1].identities![0]), false, 'old cached extraction is not treated as current');
  });

  test('literal references cannot cross employer ownership, ambiguous native issuers, or reused cohorts', () => {
    const data = fixture('databricks-winter-and-general');
    const native = data[3], feed = observe(data[4]);
    const otherEmployer = { ...feed, identities: feed.identities!.map(x => ({ ...x,
      employer: { name: 'Different Employer', kind: 'linkedin' as const, reference: 'https://www.linkedin.com/company/different' },
    })) };
    assert.equal(new OpportunityIndex([native]).find(otherEmployer), undefined);
    const secondIssuer = { ...native, id: 'second-issuer', identities: native.identities!.map(x => ({ ...x,
      postingKey: 'workday:databricks:post:123', openingKey: undefined, requisitionKey: 'workday:databricks:req:p-963',
    })) };
    assert.equal(new OpportunityIndex([native, secondIssuer]).find(feed), undefined);
    assert.equal(new OpportunityIndex([native], [feed, secondIssuer]).find(feed), undefined, 'a pending native issuer is also a competing interpretation');
    const unknownIssuer = { ...secondIssuer, identities: secondIssuer.identities!.map(x => ({ ...x, facts: undefined })) };
    assert.equal(new OpportunityIndex([native], [feed, unknownIssuer]).find(feed), undefined, 'missing duties cannot hide a competing issuer');
    const winterOnly = { ...native, identities: native.identities!.map(x => ({ ...x,
      title: 'Software Engineering Intern - Winter 2027', terms: ['winter-2027'], requisitionKey: 'greenhouse:databricks:req:P-1588',
    })) };
    assert.equal(new OpportunityIndex([winterOnly]).find(feed), undefined, 'a captured reference also vetoes a different native requisition');
    const cohorts = fixture('astranis-cohorts-share-ids').slice(0, 2);
    const unknownCohort = { ...cohorts[0], id: 'unqualified-cohort', identities: cohorts[0].identities!.map(x => ({ ...x,
      origin: 'feed' as const, postingKey: 'linkedin:post:123', sourceUrl: 'https://www.linkedin.com/jobs/view/123',
      title: 'CAD Engineer Intern 2027', terms: ['year-2027'], openingKey: undefined, requisitionKey: undefined,
      requisitionReference: '1047',
    })) };
    assert.equal(new OpportunityIndex(cohorts).find(unknownCohort), undefined);
  });

  test('a year-only title can use an explicit internship statement, not a negated or graduation statement', () => {
    assert.deepEqual(explicitInternshipTerms('Software Engineer Intern (2027)', 'This application is ONLY for Winter 2027 (January-April).'), ['winter-2027']);
    assert.deepEqual(explicitInternshipTerms('Software Engineer Intern (2027)', 'Do not apply for Summer 2027. Must graduate in Spring 2027.'), ['year-2027']);
    assert.deepEqual(explicitInternshipTerms('Software Engineer Intern (Summer 2027)', 'Internship runs Winter 2027.'), ['summer-2027']);
    assert.deepEqual(explicitInternshipTerms('Software Engineer Intern 2027', 'Interested in our Winter 2027 internship? Apply via the separate posting.'), ['year-2027']);
    assert.deepEqual(explicitInternshipTerms('Software Engineer Intern 2027', 'This internship requires graduation in Winter 2027.'), ['year-2027']);
    assert.deepEqual(explicitInternshipTerms('Software Engineer Intern 2027', 'This internship runs Summer 2027. This application is for Winter 2027.'), ['year-2027']);
    assert.deepEqual(explicitInternshipTerms('Software Engineer Intern', 'About us\nOur Summer 2025 internship program welcomed 300 interns.\nResponsibilities:\nBuild production software.'), []);
  });

  test('revisiting a legacy alias cannot downgrade refreshed extraction', () => {
    const r = fixture('valon-company-intro-truncation')[0];
    const current = observe(r);
    const merged = mergeIdentities(current.identities!, r.identities!);
    assert.equal(merged[0].version, 2);
    assert.equal(merged[0].facts?.version, 2);
    assert.ok(merged[0].facts!.roleTokens.length > 100);
    const legacy = { ...r.identities![0], title: 'Software Engineering Intern',
      employer: { kind: 'source' as const, name: 'Old display label', reference: r.link } };
    const retained = mergeIdentities(current.identities!, [legacy])[0];
    assert.equal(retained.title, current.identities![0].title);
    assert.deepEqual(retained.employer, current.identities![0].employer);
    assert.ok(hasCurrentIdentity(retained));
  });

  test('an introduction is not a footer, but trailing company text still cannot corroborate duties', () => {
    const duties = 'Responsibilities:\nBuild reliable production software, implement distributed systems and automated tests, collaborate with engineers, improve database performance and ship useful user-facing features.';
    const text = `About the Company:\nWe sell mortgages.\n${duties}\nAbout us:\nWe manufacture aircraft and sell radio equipment.`;
    const facts = openingFacts(text)!;
    assert.ok(facts.roleTokens.includes('database'));
    assert.ok(!facts.roleTokens.includes('aircraft'));
    assert.ok(!facts.roleTokens.includes('mortgages'));
  });
});
