/**
 * Baseline comparison.
 *
 * The scenario this exists for: someone edits robots.txt, the site keeps
 * working perfectly, no test fails, no error appears — and the page silently
 * stops being citable by an answer engine. That case is tested end to end
 * against a real server whose robots.txt changes between runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { auditUrl } from '../src/core/audit.js';
import { compareAudits, renderComparison, renderComparisonMarkdown } from '../src/core/compare.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOW_PRIVATE = { allowPrivate: true };

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>How does caching work in practice?</title>
<meta name="description" content="A practical explanation of caching strategies, when each applies, and how revalidation changes what your users see.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Caching","datePublished":"2026-01-01"}</script>
</head><body><h1>How does caching work in practice?</h1>
<p>Caching decides what your server never has to compute twice, and the choice between strategies is mostly a question of how stale you can afford to be.</p>
<h2>What is stale-while-revalidate?</h2>
<p>${'It serves the cached copy immediately and refreshes it in the background. '.repeat(25)}</p>
<h2>When should I use it?</h2>
<p>${'Use it whenever a slightly stale response is better than a slow one. '.repeat(25)}</p>
</body></html>`;

/** A server whose robots.txt can be swapped between audits. */
async function startMutableSite(initialRobots) {
  let robots = initialRobots;
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      if (robots === null) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(robots);
    }
    if (req.url === '/llms.txt' || req.url === '/sitemap.xml') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    setRobots: (value) => {
      robots = value;
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

const ALLOW_ALL = 'User-agent: *\nAllow: /\n';
const BLOCK_PERPLEXITY = 'User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n';

test('catches a robots.txt edit that silently removes the page from an engine', async (t) => {
  const site = await startMutableSite(ALLOW_ALL);
  t.after(() => site.stop());

  const before = await auditUrl(site.url, { tier: 'pro', fetchOptions: ALLOW_PRIVATE });
  site.setRobots(BLOCK_PERPLEXITY);
  const after = await auditUrl(site.url, { tier: 'pro', fetchOptions: ALLOW_PRIVATE });

  const diff = compareAudits(before, after);

  assert.equal(diff.regressed, true);
  assert.equal(diff.lostCrawlers.length, 1);
  assert.equal(diff.lostCrawlers[0].token, 'PerplexityBot');
  assert.equal(diff.lostCrawlers[0].was, 'allowed');
  assert.equal(diff.lostCrawlers[0].now, 'blocked');
  assert.match(diff.summary, /no longer reachable by Perplexity/);
  assert.ok(diff.scoreDelta < 0, 'the score should fall');
});

test('reports the reverse as an improvement, not a regression', async (t) => {
  const site = await startMutableSite(BLOCK_PERPLEXITY);
  t.after(() => site.stop());

  const before = await auditUrl(site.url, { tier: 'pro', fetchOptions: ALLOW_PRIVATE });
  site.setRobots(ALLOW_ALL);
  const after = await auditUrl(site.url, { tier: 'pro', fetchOptions: ALLOW_PRIVATE });

  const diff = compareAudits(before, after);

  assert.equal(diff.regressed, false);
  assert.equal(diff.lostCrawlers.length, 0);
  assert.equal(diff.crawlerChanges[0].now, 'allowed');
  assert.ok(diff.scoreDelta > 0);
  assert.match(diff.summary, /Improved by/);
  assert.ok(diff.fixed.some((issue) => issue.id === 'ai-crawlers-blocked'));
});

test('an unchanged page reports no change', async (t) => {
  const site = await startMutableSite(ALLOW_ALL);
  t.after(() => site.stop());

  const before = await auditUrl(site.url, { tier: 'pro', fetchOptions: ALLOW_PRIVATE });
  const after = await auditUrl(site.url, { tier: 'pro', fetchOptions: ALLOW_PRIVATE });

  const diff = compareAudits(before, after);
  assert.equal(diff.regressed, false);
  assert.equal(diff.scoreDelta, 0);
  assert.deepEqual(diff.introduced, []);
  assert.deepEqual(diff.fixed, []);
  assert.match(diff.summary, /No change/);
});

test('notices robots.txt disappearing entirely', async (t) => {
  const site = await startMutableSite(BLOCK_PERPLEXITY);
  t.after(() => site.stop());

  const before = await auditUrl(site.url, { tier: 'pro', fetchOptions: ALLOW_PRIVATE });
  site.setRobots(null);
  const after = await auditUrl(site.url, { tier: 'pro', fetchOptions: ALLOW_PRIVATE });

  const diff = compareAudits(before, after);
  assert.equal(diff.robotsDisappeared, true);
});

test('free-tier comparisons do not report truncated findings as fixed', async (t) => {
  const site = await startMutableSite(ALLOW_ALL);
  t.after(() => site.stop());

  const before = await auditUrl(site.url, { fetchOptions: ALLOW_PRIVATE });
  const after = await auditUrl(site.url, { fetchOptions: ALLOW_PRIVATE });

  const diff = compareAudits(before, after);
  assert.equal(diff.truncated, true);
  // Identical pages, so nothing genuinely changed — the truncation must not
  // manufacture a regression out of a partial list.
  assert.equal(diff.regressed, false);
  const terminal = renderComparison(diff, { color: false });
  assert.match(terminal, /Finding-level diff unavailable on the free tier/);
  // A partial list must not produce confidently wrong entries in either
  // direction — showing a bogus "Fixed" is worse than showing nothing.
  assert.doesNotMatch(terminal, /^Fixed \(/m);
  assert.doesNotMatch(terminal, /^Introduced \(/m);
  assert.match(renderComparisonMarkdown(diff), /Finding-level diff unavailable/);
});

test('a severity change on the same finding counts as worsening', () => {
  const base = {
    url: 'https://a.test/',
    score: 80,
    grade: 'B',
    categories: {},
    crawlers: [],
    issues: [{ id: 'title', severity: 'low', title: 'Title is short', max: 3, earned: 1.5 }],
  };
  const now = {
    ...base,
    score: 78,
    issues: [{ id: 'title', severity: 'high', title: 'Missing title tag', max: 3, earned: 0 }],
  };

  const diff = compareAudits(base, now);
  assert.equal(diff.worsened.length, 1);
  assert.equal(diff.worsened[0].from, 'low');
  assert.equal(diff.worsened[0].to, 'high');
  assert.equal(diff.regressed, true);
});

test('comparing different URLs is flagged but not fatal', () => {
  const make = (url) => ({ url, score: 70, grade: 'C', categories: {}, crawlers: [], issues: [] });
  const diff = compareAudits(make('https://staging.test/'), make('https://prod.test/'));
  assert.equal(diff.urlMismatch, true);
  assert.equal(diff.regressed, false);
  assert.match(renderComparison(diff, { color: false }), /baseline was https:\/\/staging\.test\//);
});

test('a malformed baseline is rejected with a useful message', () => {
  assert.throws(() => compareAudits({ nonsense: true }, { score: 5 }), /not an audit result/);
  assert.throws(() => compareAudits(null, { score: 5 }), /not an audit result/);
});

test('a finding title quoting the audited page cannot inject a live link into the diff', () => {
  // Finding titles can quote page content (an H1, a lang value, a robots.txt
  // token) verbatim — see report.js's mdText() fix. renderComparisonMarkdown
  // builds its own Markdown from the same finding objects via a separate
  // code path (introduced/worsened/fixed/improved), so it needs the same
  // escaping independently rather than inheriting it from report.js.
  const payload = 'Guide [click here](https://evil.test/pwn) to widgets';
  const base = {
    url: 'https://a.test/',
    score: 80,
    grade: 'B',
    categories: {},
    crawlers: [],
    issues: [],
  };
  const now = {
    ...base,
    score: 70,
    issues: [{ id: 'h1', severity: 'high', title: payload, max: 4, earned: 0 }],
  };

  const diff = compareAudits(base, now);
  assert.equal(diff.introduced.length, 1, 'fixture did not actually produce an introduced finding — test would be vacuous');

  const md = renderComparisonMarkdown(diff);
  assert.doesNotMatch(md, /(?<!\\)\]\(https:\/\/evil\.test/, 'finding title became a live Markdown link');
});

test('the CLI writes a baseline, compares against it, and exits 1 on regression', async (t) => {
  const site = await startMutableSite(ALLOW_ALL);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'citable-baseline-'));
  t.after(async () => {
    await site.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const baselinePath = path.join(dir, 'baseline.json');
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['bin/citable.js', ...args], { cwd: ROOT });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  const first = await run([site.url, '--allow-private', '--json', '--out', baselinePath]);
  assert.equal(first.code, 0);
  assert.equal(typeof JSON.parse(await readFile(baselinePath, 'utf8')).score, 'number');

  // No change yet: the gate should pass.
  const steady = await run([site.url, '--allow-private', '--baseline', baselinePath, '--fail-on-regression', '--no-color']);
  assert.equal(steady.code, 0, steady.stderr);
  assert.match(steady.stdout, /No change since the baseline/);

  // Now break it the way a real robots.txt edit would.
  site.setRobots(BLOCK_PERPLEXITY);
  const broken = await run([site.url, '--allow-private', '--baseline', baselinePath, '--fail-on-regression', '--no-color']);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /no longer reachable by Perplexity/);
  assert.match(broken.stdout, /PerplexityBot/);
});

test('--fail-on-regression without --baseline is a usage error', async () => {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['bin/citable.js', 'https://example.com', '--fail-on-regression'], { cwd: ROOT });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /needs --baseline/);
});

test('--baseline combined with --html is a usage error, not a silent fallback', async () => {
  // compare.js has no HTML renderer for a diff — only renderComparison
  // (terminal) and renderComparisonMarkdown. --html here used to be silently
  // ignored, falling back to the terminal renderer with nothing telling the
  // caller their flag did nothing.
  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['bin/citable.js', 'https://example.com', '--baseline', '/nonexistent/baseline.json', '--html'],
      { cwd: ROOT },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no HTML renderer/);
});

test('--baseline combined with --report *.html is a usage error, not a crash', async () => {
  // Confirmed live before this test existed: writeFile(path, null, 'utf8')
  // throws "The 'data' argument must be of type string...", surfaced to the
  // caller as "citable: could not write audit.html — The 'data' argument
  // must be of type string or an instance of Buffer, TypedArray, or
  // DataView. Received null" — a Node internal for a documented, foreseeable
  // combination of flags.
  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['bin/citable.js', 'https://example.com', '--baseline', '/nonexistent/baseline.json', '--report', 'diff.html'],
      { cwd: ROOT },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no HTML renderer/);
});

test('a missing baseline file exits with a usage error', async () => {
  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['bin/citable.js', 'https://example.com', '--baseline', '/nonexistent/baseline.json'],
      { cwd: ROOT },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /could not read baseline/);
});

test('a baseline of the wrong shape is named, not crashed on', async () => {
  // The baseline is a file on disk that can be hand-edited, truncated, or
  // pointed at by mistake — `--baseline package.json` is one keystroke from
  // `--baseline baseline.json`. This runs inside somebody's build, where a
  // TypeError from `.map` and the tool being broken look identical, and the
  // only thing the person reading the log needs is which file to look at.
  const current = await auditUrl('https://acme.test/page', {
    tier: 'pro',
    fetchOptions: {
      fetchImpl: async (url) => new Response(
        String(url).endsWith('/robots.txt')
          ? 'User-agent: *\nAllow: /\n'
          : `<!doctype html><html lang="en"><head><title>A page about widgets</title></head><body><main><h1>Widgets</h1><p>${'Body copy. '.repeat(80)}</p></main></body></html>`,
        { status: 200, headers: { 'content-type': String(url).endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8' } },
      ),
    },
  });

  // Not an audit result at all: one clear message, whatever the file was.
  for (const notAnAudit of [null, {}, { name: 'citable', version: '1.0.0' }, { score: NaN }, { score: '80' }]) {
    assert.throws(
      () => compareAudits(notAnAudit, current),
      /not an audit result/,
      `${JSON.stringify(notAnAudit)} should be reported, not crashed on`,
    );
  }

  // Right enough to compare, wrong in its parts: compare what is there rather
  // than throwing, since a usable verdict beats a broken build.
  for (const damaged of [
    { score: 80, issues: { a: 1 } },
    { score: 80, issues: [null, undefined] },
    { score: 80, issues: [], crawlers: 'nope' },
    { score: 80, issues: [], crawlers: [null] },
    { score: 80, issues: [], categories: 'x' },
  ]) {
    const diff = compareAudits(damaged, current);
    assert.equal(typeof diff.regressed, 'boolean', `${JSON.stringify(damaged)} should still produce a verdict`);
    assert.ok(diff.summary, 'and a summary a human can read');
  }
});

test('a baseline flag that cannot be honoured is refused, not ignored', async (t) => {
  // `--baseline` is only implemented for a single page. In site mode it was
  // parsed, accepted and dropped, so this exited 0 on every run:
  //
  //   citable site.com --site --baseline base.json --fail-on-regression
  //
  // A whole-site regression gate that could never fire, with nothing saying so
  // — the same false green as a `--min-score` that silently became NaN, and a
  // more natural thing to type, since it is the documented single-page usage
  // with `--site` added.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'citable-sitebase-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const baseline = path.join(dir, 'b.json');
  await writeFile(baseline, JSON.stringify({ score: 80, issues: [], crawlers: [] }), 'utf8');

  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'citable.js'), ...args], { cwd: dir });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });

  const withSite = await run(['https://example.test/', '--site', '--baseline', baseline, '--no-color']);
  assert.equal(withSite.code, 2, 'an unsupported combination is a usage error');
  assert.match(withSite.stderr, /cannot be combined with --site/);
  assert.match(withSite.stderr, /citable <url> --baseline/, 'and it should say what to do instead');

  // The gate flag on its own promises a comparison there is nothing to make.
  const bareGate = await run(['https://example.test/', '--fail-on-regression', '--no-color']);
  assert.equal(bareGate.code, 2);
  assert.match(bareGate.stderr, /needs --baseline/);

  // Both are rejected before any network request, so a wrong invocation costs
  // the audited site nothing.
  assert.doesNotMatch(withSite.stderr, /auditing/);
});
