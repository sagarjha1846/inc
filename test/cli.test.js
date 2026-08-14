/**
 * The CLI.
 *
 * This is the surface most people meet first — `npx citable yoursite.com` is
 * the whole acquisition argument — and it carries about twenty flags that are
 * documented in the README and in `--help`. Until now it was exercised only
 * indirectly, through the action and the integration suite, so the flags
 * themselves rested on having been tried by hand once.
 *
 * Everything here spawns the real binary against a local fixture, because the
 * things worth checking are exit codes, file side effects and output format —
 * none of which exist when the module is imported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(ROOT, 'bin', 'citable.js');

/** A page good enough to score well, so failures are about the CLI. */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>How caching strategies actually work</title>
<meta name="description" content="A practical guide to caching strategies, when each one applies, and how they interact with revalidation in production.">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
{"@type":"Organization","name":"Acme"},
{"@type":"Article","headline":"Caching","datePublished":"2026-01-01","author":{"@type":"Person","name":"Ada"}}]}</script>
</head><body><main><h1>How caching strategies actually work</h1>
<p>Caching decides what a server never computes twice, and choosing between strategies is mostly about how stale you can afford to be.</p>
<h2>What is stale-while-revalidate?</h2><ul><li>Serve cached</li><li>Refresh behind</li></ul>
<p>${'It serves the cached copy immediately while refreshing in the background. '.repeat(20)}</p>
<h2>When should I use it?</h2><p>${'Use it when a slightly stale answer beats a slow one. '.repeat(20)}</p>
<p>See <a href="https://www.rfc-editor.org/rfc/rfc9111.html">RFC 9111</a> and <a href="https://schema.org/">schema.org</a>.</p>
</main></body></html>`;

async function startSite(t) {
  let port;
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n\nSitemap: http://127.0.0.1:${port}/sitemap.xml\n`);
    }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<urlset><url><loc>http://127.0.0.1:${port}/a</loc></url><url><loc>http://127.0.0.1:${port}/b</loc></url></urlset>`);
    }
    if (req.url === '/llms.txt') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(() => server.close());
  return `http://127.0.0.1:${port}/`;
}

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'citable-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function cli(args, { cwd = ROOT, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, env: { ...process.env, ...env } },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

test('--version and --help succeed and describe the tool', async () => {
  const version = await cli(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /USAGE/);
  // Every flag the help advertises should be one the parser accepts, or the
  // first thing a reader tries fails.
  for (const flag of ['--site', '--json', '--markdown', '--html', '--out', '--report', '--baseline', '--min-score', '--fail-on']) {
    assert.ok(help.stdout.includes(flag), `--help does not mention ${flag}`);
  }
});

test('a bare invocation explains itself instead of doing nothing', async () => {
  const result = await cli([]);
  assert.equal(result.code, 2, 'no URL is a usage error, not a success');
  assert.match(result.stdout, /USAGE/);
});

test('an unknown flag is refused rather than ignored', async () => {
  // Silently ignoring it would run an audit the caller did not ask for, and in
  // CI that reads as a pass.
  const result = await cli(['example.com', '--not-a-flag']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option/);
});

test('a flag that needs a value says so when it is missing', async () => {
  const result = await cli(['example.com', '--min-score']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /needs a value/);
});

test('default output is human-readable and honours --no-color', async (t) => {
  const url = await startSite(t);
  const result = await cli([url, '--allow-private', '--no-color']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\/100/);
  assert.match(result.stdout, /Findings/);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(result.stdout, /\[/, '--no-color must emit no escape sequences');
});

test('--json emits parseable JSON and nothing else on stdout', async (t) => {
  const url = await startSite(t);
  const result = await cli([url, '--allow-private', '--json']);

  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed.score, 'number');
  assert.ok(parsed.crawlers.some((c) => c.token === 'PerplexityBot' && !c.allowed));
});

test('--markdown and --html select the report format', async (t) => {
  const url = await startSite(t);

  const markdown = await cli([url, '--allow-private', '--markdown']);
  assert.match(markdown.stdout, /^# AI Visibility Audit/m);

  const html = await cli([url, '--allow-private', '--html']);
  assert.match(html.stdout, /^<!doctype html>/);
  assert.match(html.stdout, /<\/html>/);
});

test('--out writes the primary output and keeps stdout clean', async (t) => {
  const url = await startSite(t);
  const cwd = await workspace(t);

  const result = await cli([url, '--allow-private', '--json', '--out', 'audit.json'], { cwd });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '', 'output went to the file, so stdout should be empty');
  assert.match(result.stderr, /wrote audit\.json/);

  const written = JSON.parse(await readFile(path.join(cwd, 'audit.json'), 'utf8'));
  assert.equal(typeof written.score, 'number');
});

test('--report picks its format from the file extension', async (t) => {
  const url = await startSite(t);
  const cwd = await workspace(t);

  await cli([url, '--allow-private', '--json', '--report', 'r.html'], { cwd });
  assert.match(await readFile(path.join(cwd, 'r.html'), 'utf8'), /^<!doctype html>/);

  await cli([url, '--allow-private', '--json', '--report', 'r.md'], { cwd });
  assert.match(await readFile(path.join(cwd, 'r.md'), 'utf8'), /^# AI Visibility Audit/m);
});

test('branding flags reach the HTML report', async (t) => {
  const url = await startSite(t);
  const result = await cli([
    url, '--allow-private', '--html',
    '--brand', 'Acme Digital',
    '--prepared-for', 'Client Co',
    '--accent', '#7c3aed',
  ]);

  assert.match(result.stdout, /Acme Digital — AI Visibility Audit/);
  assert.match(result.stdout, /Prepared for Client Co/);
  assert.match(result.stdout, /--accent:#7c3aed/);
});

test('--site follows the sitemap and rolls the pages up', async (t) => {
  const url = await startSite(t);
  const result = await cli([url, '--allow-private', '--site', '--limit', '5', '--json']);

  assert.equal(result.code, 0, result.stderr);
  const rollup = JSON.parse(result.stdout);
  assert.equal(rollup.pagesAudited, 2, 'the sitemap lists two pages');
  assert.equal(typeof rollup.averageScore, 'number');
  assert.ok(rollup.sitewideIssues.length > 0);
});

test('--min-score and --fail-on gate the exit code', async (t) => {
  const url = await startSite(t);

  assert.equal((await cli([url, '--allow-private', '--min-score', '1', '--no-color'])).code, 0);

  const belowFloor = await cli([url, '--allow-private', '--min-score', '100', '--no-color']);
  assert.equal(belowFloor.code, 1);
  assert.match(belowFloor.stderr, /below the required 100/);

  // The fixture blocks Perplexity, so a critical finding exists.
  const critical = await cli([url, '--allow-private', '--fail-on', 'critical', '--no-color']);
  assert.equal(critical.code, 1);

  const nonsense = await cli([url, '--allow-private', '--fail-on', 'catastrophic', '--no-color']);
  assert.equal(nonsense.code, 2, 'an unrecognised severity is a usage error');
});

test('private hosts need --allow-private, and the refusal explains itself', async (t) => {
  const url = await startSite(t);

  const refused = await cli([url, '--no-color']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /private or loopback/);

  const permitted = await cli([url, '--allow-private', '--no-color']);
  assert.equal(permitted.code, 0);

  // The environment variable is the same switch, for CI.
  const viaEnv = await cli([url, '--no-color'], { env: { CITABLE_ALLOW_PRIVATE: '1' } });
  assert.equal(viaEnv.code, 0);
});

test('an unreachable or malformed target fails with a readable message', async () => {
  const bad = await cli(['ftp://example.com/', '--no-color']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unsupported protocol/);
});

test('a licence key is accepted from the flag and from the environment', async (t) => {
  const url = await startSite(t);
  const secret = 'cli-test-signing-secret-32-characters';
  const { issueKey } = await import('../src/core/license.js');
  const { key } = await issueKey({ email: 'buyer@test.co', secret, days: 30 });
  const env = { CITABLE_LICENSE_SECRET: secret, CITABLE_ALLOW_PRIVATE: '1' };

  const viaFlag = JSON.parse((await cli([url, '--json', '--key', key], { env })).stdout);
  assert.equal(viaFlag.tier, 'pro');
  assert.ok(viaFlag.generated, 'pro output carries the generated fix files');

  const viaEnv = JSON.parse((await cli([url, '--json'], { env: { ...env, CITABLE_KEY: key } })).stdout);
  assert.equal(viaEnv.tier, 'pro');

  // A bad key degrades rather than failing: an audit is still useful.
  const rejected = await cli([url, '--json', '--key', 'CTB1.nonsense.sig'], { env });
  assert.equal(rejected.code, 0);
  assert.equal(JSON.parse(rejected.stdout).tier, 'free');
  assert.match(rejected.stderr, /not accepted/);
});

test('a numeric flag given junk is a usage error, not a reinterpretation', async (t) => {
  // These decide whether a build passes. `Number.parseInt` kept whatever it
  // produced, so a typo changed behaviour instead of stopping it:
  //
  //   --min-score abc  → NaN, and `score < NaN` is false, so the gate passed
  //                      every build. A team using `--min-score $THRESHOLD`
  //                      with the variable unset lost their regression
  //                      protection and saw nothing but green.
  //   --min-score ''   → 0, which is a gate that can never fail — the same
  //                      silent loss, and the likelier spelling of it, since an
  //                      unset CI variable expands to nothing.
  //   --limit 1e9      → 1, so a site crawl audited a single page and looked
  //                      like it had worked.
  //
  // Exit 2 throughout: a usage error, distinguishable from the audit's own
  // exit 1, so a script can tell "you configured this wrong" from "the site
  // failed the check".
  const url = await startSite(t);

  for (const [flag, value] of [
    ['--min-score', 'abc'], ['--min-score', ''], ['--min-score', '   '], ['--min-score', '200'],
    ['--min-score', '-1'], ['--limit', 'abc'], ['--limit', '0'], ['--limit', '-5'],
    ['--limit', '1e9'], ['--limit', '3.7'], ['--timeout', 'xyz'], ['--timeout', '0'],
  ]) {
    const result = await cli([url, '--allow-private', '--no-color', flag, value]);
    assert.equal(result.code, 2, `${flag} ${JSON.stringify(value)} should be a usage error, got exit ${result.code}`);
    assert.match(result.stderr, new RegExp(flag.replace(/-/g, '\\-')), `${flag} should be named in the message`);
  }
});

test('valid numeric flags still work, including the edges', async (t) => {
  // The validation must not break the values people actually pass. A zero
  // min-score is legal and pointless; an empty one is a mistake — the
  // difference matters, because rejecting both would break a real config.
  const url = await startSite(t);

  assert.equal((await cli([url, '--allow-private', '--no-color', '--min-score', '0'])).code, 0);
  assert.equal((await cli([url, '--allow-private', '--no-color', '--min-score', '100'])).code, 1, 'a real gate still fires');

  const crawl = await cli([url, '--allow-private', '--site', '--limit', '1', '--json']);
  assert.equal(crawl.code, 0, crawl.stderr);
  assert.equal(JSON.parse(crawl.stdout).pagesAudited, 1);
});

test('a write that cannot happen says why, in words', async (t) => {
  // By this point the audit has run and succeeded, so the failure is always
  // about the path. These surfaced as
  // "citable: unexpected error: Error: ENOENT: no such file or directory" —
  // a Node internal, on a documented flag, for the most foreseeable typo there
  // is, labelled "unexpected" by the program that should have expected it.
  const url = await startSite(t);
  const cwd = await workspace(t);

  const missingDir = await cli([url, '--allow-private', '--json', '--out', 'nope/deep/a.json'], { cwd });
  assert.equal(missingDir.code, 1, 'the invocation was valid, so this is not a usage error');
  assert.match(missingDir.stderr, /could not write nope\/deep\/a\.json/);
  assert.match(missingDir.stderr, /directory does not exist/);
  assert.doesNotMatch(missingDir.stderr, /unexpected error|ENOENT/, 'no raw Node error should reach the user');

  // A path that exists but is a directory is the other common slip.
  await mkdtemp(path.join(cwd, 'sub'));
  const isDir = await cli([url, '--allow-private', '--json', '--out', '.'], { cwd });
  assert.equal(isDir.code, 1);
  assert.match(isDir.stderr, /is a directory/);
  assert.doesNotMatch(isDir.stderr, /unexpected error|EISDIR/);

  // --report goes through the same path, so it must behave the same way.
  const report = await cli([url, '--allow-private', '--json', '--report', 'nope/deep/r.md'], { cwd });
  assert.equal(report.code, 1);
  assert.match(report.stderr, /could not write nope\/deep\/r\.md/);
});

test('the --fail-on count does not understate what a truncated tier hides', async (t) => {
  // The gate's verdict is always right — findings are ranked severity-first, so
  // the worst one is shown at any tier and the gate fires whenever one
  // qualifies. The count is what truncation affected: the free tier reported
  // "3 finding(s) at or above low" for a page with sixteen, in the CI log where
  // somebody decides how urgent this is.
  const url = await startSite(t);
  const secret = 'cli-failon-signing-secret-32-chars';
  const { issueKey } = await import('../src/core/license.js');
  const { key } = await issueKey({ email: 'buyer@test.co', secret, days: 0 });

  const free = await cli([url, '--allow-private', '--no-color', '--fail-on', 'low']);
  assert.equal(free.code, 1, 'the gate still fires');
  assert.match(free.stderr, /at least \d+ finding\(s\) at or above "low"/);

  const pro = await cli([url, '--allow-private', '--no-color', '--key', key, '--fail-on', 'low'], {
    env: { CITABLE_LICENSE_SECRET: secret },
  });
  assert.equal(pro.code, 1);
  assert.doesNotMatch(pro.stderr, /at least/, 'a complete list reports an exact count');

  // And the exact count must exceed the truncated one, or the hedge is pointless.
  const exact = Number(pro.stderr.match(/(\d+) finding\(s\)/)[1]);
  const shown = Number(free.stderr.match(/at least (\d+)/)[1]);
  assert.ok(exact > shown, `pro saw ${exact}, free showed ${shown} — the hedge should be doing work`);
});
