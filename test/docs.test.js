/**
 * The README makes factual claims about the code.
 *
 * Every one of them has been hand-edited at least once this session, which is
 * precisely how documentation drifts out of sync with behaviour. A stale
 * README is not cosmetic here: it is the sales page on GitHub and npm, so a
 * number that no longer matches the product is a claim that misleads a buyer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { AI_CRAWLERS } from '../src/core/robots.js';
import { CATEGORIES } from '../src/core/checks.js';
import { FREE_ISSUE_LIMIT } from '../src/core/audit.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('the crawler count claimed in the README matches the registry', () => {
  const claimed = readme.match(/(\d+) AI crawlers/);
  assert.ok(claimed, 'README should state how many crawlers are tracked');
  assert.equal(Number(claimed[1]), AI_CRAWLERS.length);
});

test('every crawler in the registry is listed in the README', () => {
  // The listed tokens are what a reader checks their own robots.txt against,
  // so a crawler added to the code but missing here is a silent gap.
  for (const crawler of AI_CRAWLERS) {
    assert.ok(readme.includes(`\`${crawler.token}\``), `README does not list ${crawler.token}`);
  }
});

test('the category weight table matches the scoring weights', () => {
  for (const category of Object.values(CATEGORIES)) {
    const row = new RegExp(`\\|\\s*${category.label}\\s*\\|\\s*(\\d+)\\s*\\|`, 'i');
    const match = readme.match(row);
    assert.ok(match, `README has no weight row for "${category.label}"`);
    assert.equal(Number(match[1]), category.weight, `weight mismatch for ${category.label}`);
  }
});

test('the free-tier finding limit claimed in the README is the real one', () => {
  const claimed = readme.match(/\| Findings shown \| Top (\d+) \|/);
  assert.ok(claimed, 'README should state the free-tier finding limit');
  assert.equal(Number(claimed[1]), FREE_ISSUE_LIMIT);
});

test('the test count claimed in the README matches the suite', () => {
  const files = readdirSync(new URL('../test/', import.meta.url)).filter((name) => name.endsWith('.test.js'));
  let total = 0;
  for (const name of files) {
    const source = readFileSync(new URL(`../test/${name}`, import.meta.url), 'utf8');
    total += (source.match(/^test\(/gm) || []).length;
  }

  const claimed = readme.match(/# (\d+) tests, no install step/);
  assert.ok(claimed, 'README should state the test count');
  assert.equal(
    Number(claimed[1]),
    total,
    `README claims ${claimed?.[1]} tests but the suite defines ${total}`,
  );
});

test('documented CLI flags exist in the CLI', () => {
  const cli = readFileSync(new URL('../bin/citable.js', import.meta.url), 'utf8');
  // Flags the README tells people to type. A documented flag that the parser
  // rejects fails with "Unknown option", which reads as a broken tool.
  // Only flags on a `citable` command line count. The README also shows
  // `node --test` and `scripts/benchmark.mjs --list`, which belong to other
  // tools entirely.
  const citableLines = readme
    .split('\n')
    .filter((line) => /(?:^|\s)(?:npx )?citable\s/.test(line) || /^\s+--/.test(line));
  const documented = citableLines.flatMap((line) => [...line.matchAll(/(?:^|\s)(--[a-z][a-z-]+)/g)].map((m) => m[1]));
  const unknown = [...new Set(documented)].filter((flag) => !cli.includes(`'${flag}'`));
  assert.deepEqual(unknown, [], `README documents flags the CLI does not accept: ${unknown.join(', ')}`);
});

test('the README example output is shaped like real CLI output', () => {
  // Pinning exact numbers would be brittle, but the example must at least be
  // internally consistent: a critical finding always yields the "Not citable"
  // verdict, never a softer one.
  const block = readme.match(/```\nhttps:\/\/yoursite\.com[\s\S]*?```/);
  assert.ok(block, 'README should contain a sample run');
  const example = block[0];

  if (example.includes('[CRITICAL]')) {
    assert.match(
      example,
      /Not citable as it stands/,
      'a critical finding must pair with the "Not citable" verdict, as the scorer produces',
    );
  }
  for (const category of Object.values(CATEGORIES)) {
    assert.ok(example.includes(category.label), `example is missing the ${category.label} row`);
  }
});

/* ------------------------------------------------------- version coherence */

test('every version string agrees with package.json', () => {
  // The version lives in three places. Nothing keeps them together, and a
  // mismatch is invisible until someone reports a bug against a version that
  // does not correspond to the code they ran.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const cli = readFileSync(new URL('../bin/citable.js', import.meta.url), 'utf8');
  const fetchSource = readFileSync(new URL('../src/core/fetch.js', import.meta.url), 'utf8');

  const cliVersion = cli.match(/const VERSION = '([^']+)'/);
  assert.ok(cliVersion, 'bin/citable.js should declare VERSION');
  assert.equal(cliVersion[1], pkg.version, 'CLI --version does not match package.json');

  // The crawler identifies itself to every site it audits, so a stale version
  // there misreports which build is making the request.
  const agentVersion = fetchSource.match(/CitableBot\/([0-9.]+)/);
  assert.ok(agentVersion, 'the user agent should carry a version');
  assert.ok(
    pkg.version.startsWith(agentVersion[1]),
    `user agent says ${agentVersion[1]} but the package is ${pkg.version}`,
  );
});
