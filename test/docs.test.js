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
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

test('the test count claimed in the README matches the suite', { skip: process.env.CITABLE_COUNTING === '1' }, async () => {
  // Counted by running the suite, not by grepping for `test(`.
  //
  // A static count is wrong the moment a file generates cases in a loop — the
  // robustness suite declares twenty-one documents that way, and the grep sees
  // one. It reported the README as overstating a number that was in fact
  // correct, which is the worst kind of guard: it fails on good input and
  // teaches you to edit the claim until the check goes quiet.
  //
  // The env var stops the child from recursing into this same test.
  // NODE_TEST_CONTEXT is how the runner detects a recursive invocation and
  // refuses to run files; the child is a fresh run, so it must not inherit it.
  const childEnv = { ...process.env, CITABLE_COUNTING: '1' };
  delete childEnv.NODE_TEST_CONTEXT;

  const child = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--test'],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), env: childEnv, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ stdout, stderr }),
    );
  });

  const reported = child.stdout.match(/^# tests (\d+)$/m);
  assert.ok(reported, `could not read a test count from the runner:\n${child.stderr.slice(0, 500)}`);
  // A skipped test still counts toward the runner's total, so the child's
  // number matches a full run and needs no adjustment. Verified rather than
  // assumed — the opposite would have made the README consistently off by one.
  const total = Number(reported[1]);

  const claimed = readme.match(/# (\d+) tests, no install step/);
  assert.ok(claimed, 'README should state the test count');
  assert.equal(Number(claimed[1]), total, `README claims ${claimed?.[1]} tests but the suite runs ${total}`);
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

/* --------------------------------------------------- install instructions */

const buildSite = readFileSync(new URL('../scripts/build-site.mjs', import.meta.url), 'utf8');

/**
 * Every `github:` install target that appears as a *command*.
 *
 * Matched only after `npx` or `npm install`, so prose explaining the shorthand
 * — "the short `github:owner/repo` form fails" — is not mistaken for an
 * instruction the reader is meant to run.
 */
function installTargets(text) {
  return [...text.matchAll(/(?:npx|npm install(?:\s+-g)?)\s+(github:[\w.-]+\/[\w.-]+(?:#[^\s`"')]+)?)/g)].map(
    (match) => match[1],
  );
}

test('documented install commands name a ref that carries the package', () => {
  // The code lives on a feature branch; the default branch holds only the
  // README. `github:owner/repo` resolves to the default branch, so the short
  // form installs nothing and fails with ENOENT — which is what the headline
  // command on the README and the published landing page both used to say.
  const targets = [...installTargets(readme), ...installTargets(buildSite)];
  assert.ok(targets.length > 0, 'expected install commands to be documented');

  for (const target of targets) {
    assert.ok(
      target.includes('#'),
      `"${target}" resolves to the default branch, which does not carry package.json. ` +
        'Pin the ref, or merge the code to the default branch and update this test.',
    );
  }
});

test('the README and the published landing page agree on how to install', () => {
  // The landing page is generated separately, so the two drift independently
  // and a reader can be told two different things by the same product.
  const fromReadme = new Set(installTargets(readme));
  const fromSite = new Set(installTargets(buildSite));
  for (const target of fromSite) {
    assert.ok(fromReadme.has(target), `the site says "${target}" but the README never does`);
  }
});

test('no example invokes a command that is not installable yet', () => {
  // `npx citable` only works once the package is on npm. Until then every
  // example has to be reachable, either through the bare binary after an
  // install step or through the pinned github: form.
  // At the start of a line, i.e. as something to run. The same words inside a
  // sentence about what will work after publishing are a statement, not an
  // instruction.
  assert.doesNotMatch(readme, /^\s*npx citable\b/m, 'npx citable 404s until the package is published');
  assert.match(readme, /^## Install$/m, 'the README needs an install section for the bare command to make sense');
});
