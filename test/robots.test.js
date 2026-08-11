import test from 'node:test';
import assert from 'node:assert/strict';

import { AI_CRAWLERS, crawlerMatrix, isAllowed, parseRobots } from '../src/core/robots.js';

test('parseRobots groups consecutive user-agent lines together', () => {
  const parsed = parseRobots(`
User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /private

User-agent: *
Allow: /

Sitemap: https://a.test/sitemap.xml
`);
  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.groups[0].agents, ['gptbot', 'claudebot']);
  assert.deepEqual(parsed.sitemaps, ['https://a.test/sitemap.xml']);
});

test('parseRobots ignores comments and blank lines', () => {
  const parsed = parseRobots('# comment\nUser-agent: *  # trailing\nDisallow: /x\n\n');
  assert.equal(parsed.groups.length, 1);
  assert.deepEqual(parsed.groups[0].rules, [{ type: 'disallow', path: '/x' }]);
});

test('isAllowed prefers the most specific user-agent group over the wildcard', () => {
  const parsed = parseRobots(`
User-agent: *
Disallow: /

User-agent: GPTBot
Allow: /
`);
  assert.equal(isAllowed(parsed, 'GPTBot', '/page').allowed, true);
  assert.equal(isAllowed(parsed, 'RandomBot', '/page').allowed, false);
});

test('isAllowed applies longest-match with allow winning ties', () => {
  const parsed = parseRobots(`
User-agent: *
Disallow: /blog
Allow: /blog/public
`);
  assert.equal(isAllowed(parsed, 'AnyBot', '/blog/private').allowed, false);
  assert.equal(isAllowed(parsed, 'AnyBot', '/blog/public/post').allowed, true);
});

test('isAllowed handles wildcard and end-anchored patterns', () => {
  const parsed = parseRobots(`
User-agent: *
Disallow: /*.pdf$
Disallow: /a/*/secret
`);
  assert.equal(isAllowed(parsed, 'AnyBot', '/files/report.pdf').allowed, false);
  assert.equal(isAllowed(parsed, 'AnyBot', '/files/report.pdf.html').allowed, true);
  assert.equal(isAllowed(parsed, 'AnyBot', '/a/b/secret').allowed, false);
  assert.equal(isAllowed(parsed, 'AnyBot', '/a/b/public').allowed, true);
});

test('wildcard patterns backtrack to find a match anywhere', () => {
  // A left-to-right scan that commits to the first occurrence of each literal
  // gets these wrong, and gets them wrong in the dangerous direction: it
  // reports "allowed" for a page the site actually blocks.
  const cases = [
    // [pattern, path, blocked]
    ['/*.pdf$', '/files/report.pdf', true],
    ['/*.pdf$', '/files/report.pdf.html', false],
    ['/a*$', '/abc', true],
    ['/a*$', '/a', true],
    ['/a*$', '/b', false],
    ['/*b$', '/abcb', true],
    ['/*b$', '/abc', false],
    ['/a*b*c$', '/axxbyyc', true],
    ['/a*b*c$', '/axxbyyd', false],
    ['/blog$', '/blog', true],
    ['/blog$', '/blog/post', false],
    ['/*', '/anything', true],
    ['/', '/anything', true],
  ];

  for (const [pattern, path, blocked] of cases) {
    const parsed = parseRobots(`User-agent: *\nDisallow: ${pattern}\n`);
    assert.equal(
      isAllowed(parsed, 'GPTBot', path).allowed,
      !blocked,
      `${pattern} vs ${path} should be ${blocked ? 'blocked' : 'allowed'}`,
    );
  }
});

test('a hostile robots.txt pattern cannot stall the matcher', () => {
  // robots.txt is fetched from arbitrary sites, so a pattern designed to
  // trigger catastrophic backtracking is an availability concern for the
  // hosted worker, not a hypothetical.
  const evil = `/${'*a'.repeat(30)}$`;
  const path = `/${'a'.repeat(5000)}`;
  const parsed = parseRobots(`User-agent: *\nDisallow: ${evil}\n`);

  const startedAt = Date.now();
  isAllowed(parsed, 'GPTBot', path);
  assert.ok(Date.now() - startedAt < 1000, 'matching should stay linear-ish, not blow up');
});

test('empty Disallow means allow everything', () => {
  const parsed = parseRobots('User-agent: *\nDisallow:');
  assert.equal(isAllowed(parsed, 'AnyBot', '/anything').allowed, true);
});

test('missing robots rules default to allowed', () => {
  const parsed = parseRobots('');
  assert.equal(isAllowed(parsed, 'GPTBot', '/').allowed, true);
});

test('crawlerMatrix reports every known AI crawler with its verdict', () => {
  const matrix = crawlerMatrix('User-agent: *\nDisallow: /\n', '/');
  assert.equal(matrix.length, AI_CRAWLERS.length);
  assert.ok(matrix.every((crawler) => crawler.allowed === false));
  assert.ok(matrix.every((crawler) => crawler.explicit === false));
});

test('user-agent groups match by prefix, not substring', () => {
  // Substring matching hands a `User-agent: bot` group every crawler whose
  // name merely contains "bot", which reports a site as blocking eight answer
  // engines when it blocks none — a false alarm the user would act on.
  const blockedBy = (agentLine) =>
    crawlerMatrix(`User-agent: ${agentLine}\nDisallow: /\n\nUser-agent: *\nAllow: /\n`, '/')
      .filter((crawler) => !crawler.allowed)
      .map((crawler) => crawler.token);

  assert.deepEqual(blockedBy('bot'), [], 'no product token starts with "bot"');
  assert.deepEqual(blockedBy('Search'), [], 'no product token starts with "search"');
  assert.deepEqual(blockedBy('GPTBot'), ['GPTBot']);
  assert.deepEqual(blockedBy('Perplexity'), ['PerplexityBot', 'Perplexity-User']);
  assert.deepEqual(blockedBy('Claude'), ['ClaudeBot', 'Claude-SearchBot', 'Claude-User']);
});

test('the longest matching user-agent prefix wins', () => {
  // A site can block the vendor broadly while allowing its indexing crawler.
  const matrix = crawlerMatrix(
    'User-agent: Claude\nDisallow: /\n\nUser-agent: Claude-SearchBot\nAllow: /\n\nUser-agent: *\nAllow: /\n',
    '/',
  );
  const byToken = Object.fromEntries(matrix.map((crawler) => [crawler.token, crawler.allowed]));
  assert.equal(byToken['Claude-SearchBot'], true, 'the more specific group should win');
  assert.equal(byToken.ClaudeBot, false);
  assert.equal(byToken['Claude-User'], false);
});

test('crawlerMatrix marks explicitly named crawlers', () => {
  const matrix = crawlerMatrix('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n', '/');
  const gptbot = matrix.find((crawler) => crawler.token === 'GPTBot');
  const perplexity = matrix.find((crawler) => crawler.token === 'PerplexityBot');
  assert.equal(gptbot.allowed, false);
  assert.equal(gptbot.explicit, true);
  assert.equal(gptbot.rule, 'Disallow: /');
  assert.equal(perplexity.allowed, true);
  assert.equal(perplexity.explicit, false);
});

test('every registered crawler carries the fields the report needs', () => {
  for (const crawler of AI_CRAWLERS) {
    assert.ok(crawler.token && crawler.vendor && crawler.surface, `${crawler.token} missing identity fields`);
    assert.ok(['citation', 'training', 'live-fetch'].includes(crawler.purpose), `${crawler.token} has an unknown purpose`);
    assert.ok(crawler.weight > 0, `${crawler.token} needs a positive weight`);
  }
});
