/**
 * Drives scripts/benchmark.mjs as a subprocess against fixture sites with
 * known defects, and checks the aggregate numbers it publishes.
 *
 * These figures are the ones that would go in a public writeup, so a silent
 * arithmetic error here would mean publishing something false. That makes the
 * study generator worth testing more carefully than a normal script.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const RICH = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>What is answer engine optimization?</title>
<meta name="description" content="Answer engine optimization is the practice of structuring a site so AI assistants can crawl, read and cite it accurately in their answers.">
<meta property="og:title" content="AEO"><meta property="og:description" content="AEO explained."><meta name="author" content="Ada">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Co"},{"@type":"Article","headline":"AEO","datePublished":"2026-01-01"}]}</script>
</head><body><h1>What is answer engine optimization?</h1>
<p>Answer engine optimization is the practice of structuring a site so that AI assistants can crawl it, read it without JavaScript, and cite it accurately.</p>
<h2>Why does it matter?</h2><ul><li>Citations</li><li>Traffic</li></ul>
<p>${'It matters because assistants now mediate discovery for a growing share of queries. '.repeat(25)}</p>
<h2>How do I start?</h2>
<p>${'Start by checking your robots file and whether the server renders content. '.repeat(25)}</p>
<p><a href="https://schema.org/">schema.org</a> <a href="https://www.rfc-editor.org/rfc/rfc9309.html">RFC 9309</a></p>
</body></html>`;

const SPA = `<!doctype html><html><head><title>App</title><script>${'var a=1;'.repeat(900)}</script></head><body><div id="root"></div></body></html>`;

const FIXTURES = [
  // Clean site: nothing blocked, has llms.txt.
  { html: RICH, robots: 'User-agent: *\nAllow: /\n', llms: true },
  // Blocks three citation crawlers explicitly.
  {
    html: RICH,
    robots: 'User-agent: GPTBot\nDisallow: /\nUser-agent: PerplexityBot\nDisallow: /\nUser-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n',
  },
  // Client-rendered shell.
  { html: SPA, robots: 'User-agent: *\nAllow: /\n' },
  // Blanket disallow — blocks everything.
  { html: RICH, robots: 'User-agent: *\nDisallow: /\n' },
  // No robots.txt at all: nothing blocked, but no explicit policy either.
  { html: RICH, robots: null },
];

async function startFixtures() {
  const servers = [];
  for (const fixture of FIXTURES) {
    const server = http.createServer((req, res) => {
      if (req.url === '/robots.txt') {
        if (!fixture.robots) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(fixture.robots);
      }
      if (req.url === '/llms.txt') {
        if (!fixture.llms) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('# Co\n\n> Guides.\n\n## Pages\n\n- [A](http://a): a\n- [B](http://b): b\n- [C](http://c): c\n');
      }
      if (req.url === '/sitemap.xml') {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fixture.html);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push({ server, url: `http://127.0.0.1:${server.address().port}/` });
  }
  return servers;
}

test('the study generator reports accurate aggregates', async (t) => {
  const servers = await startFixtures();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'citable-bench-'));
  t.after(async () => {
    for (const entry of servers) entry.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const listPath = path.join(dir, 'domains.txt');
  await writeFile(listPath, `# fixtures\n${servers.map((entry) => entry.url).join('\n')}\n`);

  const outBase = path.join(dir, 'study');
  const exitCode = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['scripts/benchmark.mjs', '--list', listPath, '--out', outBase, '--concurrency', '2', '--allow-private'],
      { cwd: ROOT, stdio: 'ignore' },
    );
    child.on('close', resolve);
  });
  assert.equal(exitCode, 0);

  const markdown = await readFile(`${outBase}.md`, 'utf8');
  const data = JSON.parse(await readFile(`${outBase}.json`, 'utf8'));

  assert.equal(data.sitesAudited, 5);
  assert.equal(data.sitesAttempted, 5);

  // Two of the four sites that publish a robots.txt block citation crawlers.
  // The fifth has no robots.txt and is correctly excluded from that base.
  assert.match(markdown, /Block at least one crawler that produces AI citations \| \*\*50%\*\* \(2 of 4 with a robots\.txt\)/);

  // Exactly one fixture is a client-rendered shell.
  assert.match(markdown, /Serve content only after JavaScript runs.*\*\*20%\*\* \(1\)/);

  // PerplexityBot is blocked by the explicit-block fixture and the blanket
  // one: 2 of 4 sites with a robots.txt.
  assert.match(markdown, /\| `PerplexityBot` \| Perplexity \| citation \| 50% \|/);

  // Only the first fixture publishes a usable llms.txt.
  assert.match(markdown, /Have no usable llms\.txt \| \*\*80%\*\* \(4\)/);

  // The method section must keep the honesty caveat — the numbers are only
  // publishable if their basis is stated.
  assert.match(markdown, /judgement call, not an empirically derived model/);

  // Raw data must back every claim.
  const spa = data.results.find((entry) => entry.score < 50);
  assert.ok(spa, 'expected the client-rendered fixture to score badly');
  assert.ok(spa.findings.some((finding) => finding.id === 'js-rendered' && finding.severity === 'critical'));
});

test('a typo in --concurrency or --timeout is refused, not silently reinterpreted', async (t) => {
  // Number.parseInt reads only as much of the string as looks like a number
  // and discards the rest, so "--timeout 1500o" (a slip for 1500, or 15000)
  // used to run with 1500ms rather than failing — the same class of bug
  // fixed in bin/citable.js's nextNumber() and issue-key.mjs's strictInt().
  // Neither audits a real site, so no fixture server is needed: the
  // validation runs before the target list is even read for --timeout, and
  // before any fetch for --concurrency.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'citable-bench-typo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const listPath = path.join(dir, 'domains.txt');
  await writeFile(listPath, 'https://example.test/\n');

  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['scripts/benchmark.mjs', '--list', listPath, ...args], { cwd: ROOT });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (code) => resolve({ code, stderr }));
    });

  const badConcurrency = await run(['--concurrency', '2x']);
  assert.equal(badConcurrency.code, 2);
  assert.match(badConcurrency.stderr, /--concurrency must be a whole number/);

  const badTimeout = await run(['--timeout', '1500o']);
  assert.equal(badTimeout.code, 2);
  assert.match(badTimeout.stderr, /--timeout must be a whole number/);

  const zeroTimeout = await run(['--timeout', '0']);
  assert.equal(zeroTimeout.code, 2);
  assert.match(zeroTimeout.stderr, /--timeout must be at least 1ms/);
});
