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

test('percent-encoding differences do not hide a block', () => {
  // The two sides routinely arrive encoded differently: `new URL()` encodes a
  // pathname, while a CMS writes literal UTF-8 into robots.txt. If these fail
  // to match, the audit says "allowed" for a page the site actually blocks —
  // the direction that tells someone they are visible when they are not.
  const literal = parseRobots('User-agent: *\nDisallow: /\u00fcber\n');
  assert.equal(isAllowed(literal, 'Bot', '/%C3%BCber').allowed, false, 'encoded path vs literal pattern');
  assert.equal(isAllowed(literal, 'Bot', '/\u00fcber').allowed, false, 'literal path vs literal pattern');

  const encoded = parseRobots('User-agent: *\nDisallow: /%C3%BCber\n');
  assert.equal(isAllowed(encoded, 'Bot', '/\u00fcber').allowed, false, 'literal path vs encoded pattern');
  assert.equal(isAllowed(encoded, 'Bot', '/%c3%bcber').allowed, false, 'hex case is normalised');

  // An unrelated non-ASCII path must still be allowed.
  assert.equal(isAllowed(literal, 'Bot', '/andere').allowed, true);
});

test('a percent-encoded reserved character stays distinct from the character', () => {
  // Decoding %2F into "/" would turn one path segment into two and silently
  // widen the rule, so the escape must be preserved rather than resolved.
  const parsed = parseRobots('User-agent: *\nDisallow: /a%2Fb\n');
  assert.equal(isAllowed(parsed, 'Bot', '/a%2Fb').allowed, false);
  assert.equal(isAllowed(parsed, 'Bot', '/a/b').allowed, true, '/a/b is a different path from /a%2Fb');
});

test('wildcards backtrack instead of committing to the first match', () => {
  // A left-to-right scan that takes the first "b" reports this as allowed.
  const parsed = parseRobots('User-agent: *\nDisallow: /a*b$\n');
  assert.equal(isAllowed(parsed, 'Bot', '/abxb').allowed, false, 'the * must give up "b" and take "bx"');
  assert.equal(isAllowed(parsed, 'Bot', '/axxb').allowed, false);
  assert.equal(isAllowed(parsed, 'Bot', '/axxc').allowed, true);

  const ext = parseRobots('User-agent: *\nDisallow: /*.pdf$\n');
  assert.equal(isAllowed(ext, 'Bot', '/a.pdf.pdf').allowed, false, 'the final .pdf is at the end');
});

test('a trailing wildcard before $ still matches to the end', () => {
  const parsed = parseRobots('User-agent: *\nDisallow: /*$\n');
  for (const path of ['/', '/foo', '/deep/path/here']) {
    assert.equal(isAllowed(parsed, 'Bot', path).allowed, false, `${path} should be blocked`);
  }
});

test('a pathological pattern cannot hang the matcher', () => {
  // robots.txt comes from an arbitrary site, so a pattern that a naive regex
  // translation would blow up on must stay cheap.
  const parsed = parseRobots(`User-agent: *\nDisallow: /${'a*'.repeat(24)}b$\n`);
  const started = Date.now();
  assert.equal(isAllowed(parsed, 'Bot', `/${'a'.repeat(600)}`).allowed, true);
  assert.ok(Date.now() - started < 1000, 'matching should not blow up on adversarial input');
});
