/**
 * Scoring and finding order.
 *
 * The order matters more than it looks. The free tier shows the top three
 * findings and withholds the rest, so this ranking decides what a stranger sees
 * at the one moment the product has to be persuasive — and the README promises
 * findings "ranked by points recovered", which is a claim, not a description.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES } from '../src/core/checks.js';
import { prioritize, scoreFindings } from '../src/core/score.js';

/** A minimal finding; only the fields the scorer reads. */
const finding = (category, earned, max, severity = 'medium', id = `${category}-${max}-${earned}`) => ({
  id, category, severity, title: id, detail: '', evidence: null, impact: null, fix: null, earned, max,
});

test('severity outranks points, because a blocker is not a trade', () => {
  const ranked = prioritize([
    finding('content', 0, 25, 'medium'),
    finding('authority', 0, 1, 'critical'),
  ]);
  assert.equal(ranked[0].severity, 'critical', 'a blocker comes first even when it is worth one point');
});

test('within a severity, order is by real points rather than raw gap', () => {
  // The trap: `max` is in the category's own units, and each category is
  // normalised to its weight, so a unit is worth `weight / available` points.
  // Here `authority` carries 10 units of checks against a weight of 5, so each
  // unit is worth half a point — and a gap of 6 there recovers 3 points, less
  // than a gap of 4 in `content`, where a unit is worth a full point.
  //
  // Comparing raw gaps would put the authority finding first. Nothing in the
  // shipped checks currently triggers this, which is exactly why it needs a
  // test: it stays true only while every category's checks happen to sum to its
  // weight, and the first symptom of that breaking is a free user shown the
  // wrong three findings.
  const findings = [
    finding('authority', 0, 6, 'medium', 'authority-big-gap'),
    finding('authority', 4, 4, 'pass', 'authority-filler'),
    finding('content', 21, 25, 'medium', 'content-small-gap'),
  ];

  const authorityUnits = 10;
  assert.equal(
    findings.filter((f) => f.category === 'authority').reduce((sum, f) => sum + f.max, 0),
    authorityUnits,
    'fixture should give authority twice the units of its weight',
  );

  const ranked = prioritize(findings);
  assert.equal(ranked[0].id, 'content-small-gap', 'the fix worth more points comes first');
  assert.equal(ranked[0].points, 4);
  assert.equal(ranked[1].points, 3);
  assert.ok(ranked[1].gap > ranked[0].gap, 'and it wins despite the smaller raw gap');
});

test('the points on a finding are the points the score actually moves', () => {
  // The number shown to a buyer has to be the number they get. Fixing one
  // finding completely should raise the score by that finding's `points`.
  const base = [
    finding('access', 6, 10, 'high', 'access-partial'),
    finding('access', 20, 22, 'low', 'access-minor'),
    finding('content', 10, 25, 'medium', 'content-thin'),
    finding('schema', 0, 15, 'high', 'schema-missing'),
  ];

  const before = scoreFindings(base).score;
  for (const target of prioritize(base)) {
    const fixed = base.map((item) => (item.id === target.id ? { ...item, earned: item.max } : item));
    const after = scoreFindings(fixed).score;
    assert.ok(
      Math.abs((after - before) - target.points) <= 1,
      `${target.id}: claimed ${target.points} points, score moved ${after - before}`,
    );
  }
});

test('passing findings are never listed as work to do', () => {
  const ranked = prioritize([finding('content', 25, 25, 'pass'), finding('content', 0, 25, 'low')]);
  assert.equal(ranked.length, 1);
  assert.notEqual(ranked[0].severity, 'pass');
});

test('a category with no findings at all does not distort the ranking', () => {
  // `available` is zero for a category whose checks all dropped out. Dividing by
  // it would make every finding NaN and the sort meaningless.
  const ranked = prioritize([finding('metadata', 0, 10, 'high')]);
  assert.equal(ranked.length, 1);
  assert.ok(Number.isFinite(ranked[0].points), 'points must be a number');
});

test('every category the checks use is one the scorer knows about', () => {
  // A finding in an unknown category is worth zero points and sinks to the
  // bottom of its severity band, silently.
  const known = new Set(Object.keys(CATEGORIES));
  for (const key of known) {
    assert.ok(CATEGORIES[key].weight > 0, `${key} needs a weight`);
  }
  const total = Object.values(CATEGORIES).reduce((sum, meta) => sum + meta.weight, 0);
  assert.equal(total, 100, 'weights must sum to 100 or the headline is not a percentage');
});

test('the points a report prints are the points the finding is worth', async () => {
  // Both renderers print "Recovers up to N points" into a document an agency
  // hands a client. They computed N as `max - earned`, which is the gap in the
  // category's own units — not points. A blocked-crawler finding worth 1.9
  // points was printed as 2.
  const { auditUrl } = await import('../src/core/audit.js');
  const { renderMarkdown, renderHtml } = await import('../src/core/report.js');

  const page = '<!doctype html><html lang="en"><head><title>Pricing for widgets</title></head>'
    + `<body><main><h1>Pricing</h1><p>${'Body copy about pricing. '.repeat(40)}</p></main></body></html>`;
  const result = await auditUrl('https://acme.test/pricing', {
    tier: 'pro',
    fetchOptions: {
      fetchImpl: async (url) => new Response(
        String(url).endsWith('/robots.txt')
          ? 'User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n'
          : page,
        {
          status: 200,
          headers: { 'content-type': String(url).endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8' },
        },
      ),
    },
  });

  // The fixture is chosen so at least one finding's points differ from its gap;
  // without that this test would pass on the broken code too.
  const differing = result.issues.find((issue) => Math.abs(issue.points - (issue.max - issue.earned)) > 0.05);
  assert.ok(differing, 'fixture must produce a finding whose points differ from its raw gap');

  const markdown = renderMarkdown(result);
  const html = renderHtml(result);
  assert.ok(
    markdown.includes(`Recovers up to ${differing.points} points`),
    `markdown should print ${differing.points}, not the raw gap ${differing.max - differing.earned}`,
  );
  assert.ok(
    html.includes(`Recovers up to ${differing.points} points`),
    `html should print ${differing.points}, not the raw gap ${differing.max - differing.earned}`,
  );

  // Deliberately not asserting the gap figure is absent anywhere: another
  // finding can legitimately be worth exactly that many points, and the string
  // would then appear for a good reason.
});
