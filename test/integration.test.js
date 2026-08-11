/**
 * End-to-end tests over real HTTP.
 *
 * The other suites stub fetch, which is fast but proves nothing about the
 * network layer: redirects, streaming body reads, size caps, header parsing
 * and the timeout path all only exist against a real socket. This suite runs a
 * throwaway server on loopback and drives the full stack against it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { auditUrl, auditSite, urlsFromSitemap } from '../src/core/audit.js';
import { fetchPage } from '../src/core/fetch.js';

const ALLOW_PRIVATE = { allowPrivate: true };

function page(port) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>How do AI crawlers read a page?</title>
<meta name="description" content="A practical explanation of how AI crawlers fetch and parse pages, and what that means for whether your content can be cited by an answer engine.">
<link rel="canonical" href="http://127.0.0.1:${port}/">
<meta property="og:title" content="How do AI crawlers read a page?">
<meta property="og:description" content="How AI crawlers fetch and parse pages.">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
{"@type":"Organization","name":"Stub Co","url":"http://127.0.0.1:${port}"},
{"@type":"Article","headline":"How do AI crawlers read a page?","datePublished":"2026-01-01","dateModified":"2026-02-01","author":{"@type":"Person","name":"Ada"}}]}</script>
</head><body>
<h1>How do AI crawlers read a page?</h1>
<p>AI crawlers fetch the raw HTML and parse the text without running JavaScript, so anything rendered on the client is invisible to them.</p>
<h2>What does a crawler actually download?</h2>
<p>${'It downloads exactly the bytes your server returns and nothing more. '.repeat(25)}</p>
<h2>How should I structure a page?</h2>
<ul><li>One H1</li><li>Question headings</li><li>Lists and tables</li></ul>
<p>${'Structure the page so that each section answers one question completely. '.repeat(25)}</p>
<p>See <a href="https://www.rfc-editor.org/rfc/rfc9309.html">RFC 9309</a> and <a href="https://schema.org/Article">schema.org</a>.</p>
</body></html>`;
}

/** Start a stub site; returns its origin and a stop function. */
async function startSite() {
  let port;
  const server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(
        `User-agent: *\nAllow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nSitemap: http://127.0.0.1:${port}/sitemap.xml\n`,
      );
    }
    if (url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(
        `<urlset><url><loc>http://127.0.0.1:${port}/</loc></url><url><loc>http://127.0.0.1:${port}/second</loc></url></urlset>`,
      );
    }
    if (url === '/llms.txt') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    if (url === '/moved') {
      res.writeHead(301, { location: `http://127.0.0.1:${port}/` });
      return res.end();
    }
    if (url === '/huge') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<html><body>${'<p>padding padding padding</p>'.repeat(60000)}</body></html>`);
    }
    if (url === '/slow') {
      // Never responds — exercises the timeout path.
      return;
    }
    if (url === '/gone') {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<html><body>Not found</body></html>');
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(port));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('audits a real page over HTTP and detects the blocked crawler', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());

  const result = await auditUrl(`${site.origin}/`, { tier: 'pro', fetchOptions: ALLOW_PRIVATE });

  assert.ok(result.score >= 85, `expected a high score, got ${result.score}`);
  assert.equal(result.http.status, 200);
  assert.ok(result.stats.words > 400);

  const blocked = result.crawlers.filter((crawler) => !crawler.allowed);
  assert.deepEqual(blocked.map((crawler) => crawler.token), ['PerplexityBot']);

  const finding = result.issues.find((issue) => issue.id === 'ai-crawlers-blocked');
  assert.ok(finding, 'expected the blocked-crawler finding');
  assert.match(finding.evidence, /PerplexityBot/);

  // The generated patch must specifically address what was found.
  assert.match(result.generated.robotsTxt, /User-agent: PerplexityBot\nAllow: \//);
  assert.match(result.generated.robotsTxt, /<-- currently blocked/);
  assert.match(result.generated.llmsTxt, /^# /);
  assert.ok(result.generated.faqSchema.markup, 'question headings should yield FAQ schema');
});

test('follows redirects and records the chain', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());

  const response = await fetchPage(`${site.origin}/moved`, ALLOW_PRIVATE);
  assert.equal(response.status, 200);
  assert.equal(response.finalUrl, `${site.origin}/`);
  assert.equal(response.redirects.length, 1);
  assert.equal(response.redirects[0].status, 301);
});

test('caps oversized responses instead of reading them whole', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());

  const response = await fetchPage(`${site.origin}/huge`, { ...ALLOW_PRIVATE, maxBytes: 50_000 });
  assert.equal(response.truncated, true);
  assert.ok(response.body.length <= 60_000, `body was ${response.body.length} bytes`);

  const result = await auditUrl(`${site.origin}/huge`, {
    tier: 'pro',
    fetchOptions: { ...ALLOW_PRIVATE, maxBytes: 50_000 },
  });
  assert.ok(result.issues.some((issue) => issue.id === 'page-size'));
});

test('times out rather than hanging on a stalled server', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());

  await assert.rejects(
    () => fetchPage(`${site.origin}/slow`, { ...ALLOW_PRIVATE, timeoutMs: 300 }),
    (error) => error.code === 'timeout',
  );
});

test('a server that stalls mid-body is cut off at the deadline', async (t) => {
  // Headers arrive promptly, then the body trickles forever. Clearing the
  // abort timer once headers land leaves this read unbounded, which lets any
  // site pin a worker invocation indefinitely.
  let ticker;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<html><body><p>start</p>');
    ticker = setInterval(() => {
      try {
        res.write('.');
      } catch {
        /* closed */
      }
    }, 200);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    clearInterval(ticker);
    server.close();
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => fetchPage(`http://127.0.0.1:${server.address().port}/`, { ...ALLOW_PRIVATE, timeoutMs: 1000 }),
    (error) => error.code === 'timeout',
  );
  assert.ok(Date.now() - startedAt < 5000, 'should abort near the deadline, not hang');
});

test('the timeout is a total budget, not a per-redirect one', async (t) => {
  // Each hop is slower than nothing but faster than the timeout, so a per-hop
  // timer would allow maxRedirects x timeoutMs of total wall time.
  let port;
  const server = http.createServer((req, res) => {
    const hop = Number(req.url.slice(1)) || 0;
    setTimeout(() => {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/${hop + 1}` });
      res.end();
    }, 400);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(() => server.close());

  const startedAt = Date.now();
  await assert.rejects(
    () => fetchPage(`http://127.0.0.1:${port}/0`, { ...ALLOW_PRIVATE, timeoutMs: 1000 }),
    (error) => error.code === 'timeout',
  );
  assert.ok(Date.now() - startedAt < 3000, 'total elapsed should respect the single budget');
});

test('a 404 page is scored as a blocking failure', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());

  const result = await auditUrl(`${site.origin}/gone`, { tier: 'pro', fetchOptions: ALLOW_PRIVATE });
  const status = result.issues.find((issue) => issue.id === 'http-status');
  assert.equal(status.severity, 'critical');
  assert.match(result.verdict, /Not citable/);
});

test('site mode walks the sitemap and rolls up recurring issues', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());

  const urls = await urlsFromSitemap(site.origin, { limit: 10, fetchOptions: ALLOW_PRIVATE });
  assert.equal(urls.length, 2);

  const rollup = await auditSite(urls, { tier: 'pro', fetchOptions: ALLOW_PRIVATE, delayMs: 0 });
  assert.equal(rollup.pagesAudited, 2);
  assert.equal(rollup.pagesFailed, 0);
  assert.ok(rollup.averageScore >= 85);

  // Both pages share a template, so the blocked crawler shows up on both.
  const recurring = rollup.sitewideIssues.find((issue) => issue.id === 'ai-crawlers-blocked');
  assert.ok(recurring);
  assert.equal(recurring.pages, 2);
});
