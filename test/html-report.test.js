/**
 * Tests for the HTML client deliverable.
 *
 * This report is handed to paying clients, so the failure modes that matter
 * are not layout: they are unescaped page content breaking out of the markup,
 * a free-tier report silently leaking paid content, and branding that gets
 * ignored. Those are what is asserted here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { auditUrl } from '../src/core/audit.js';
import { renderHtml } from '../src/core/report.js';

const ALLOW_PRIVATE = { allowPrivate: true };

// Deliberately hostile page content: a title that closes tags, a heading with
// a script in it, and an entity. All of it must survive as inert text.
const HOSTILE = `<!doctype html><html lang="en"><head>
<title></title><script>alert(1)</script><h1>pwned</h1></title>
<meta name="description" content="Quotes &quot; and &lt;tags&gt; &amp; ampersands">
</head><body>
<h1>Heading with </h1><img src=x onerror=alert(2)> trailing</h1>
<p>${'Body text that is long enough to count as real content on this page. '.repeat(20)}</p>
<h2>Is this escaped?</h2><p>${'Yes it should be, everywhere it appears in the report. '.repeat(20)}</p>
</body></html>`;

async function auditFixture(html, { robots = 'User-agent: *\nAllow: /\n', tier = 'pro' } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(robots);
    }
    if (req.url === '/llms.txt' || req.url === '/sitemap.xml') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await auditUrl(`http://127.0.0.1:${port}/`, { tier, fetchOptions: ALLOW_PRIVATE });
  } finally {
    server.close();
  }
}

test('renders a complete, self-contained document', async () => {
  const result = await auditFixture(HOSTILE);
  const html = renderHtml(result);

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /Score breakdown/);
  assert.match(html, /Which AI engines can reach this page/);
  assert.match(html, /Ready-to-ship fixes/);

  // No external requests: the report must open offline and survive email.
  assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /@import/i);
});

test('escapes page-controlled content instead of executing it', async () => {
  const result = await auditFixture(HOSTILE);
  const html = renderHtml(result);

  // The report contains no scripts of its own, and page content must not be
  // able to introduce any markup — checked on tag delimiters rather than on
  // attribute substrings, which appear harmlessly inside escaped text.
  assert.doesNotMatch(html, /<script/i, 'the report should contain no script tags whatsoever');
  assert.doesNotMatch(html, /<img\b/i, 'no img element may be introduced by page content');

  // The audited page's markup must appear escaped, not live.
  assert.match(html, /&lt;/);
  assert.doesNotMatch(html, /<h1>pwned<\/h1>/);
});

test('a hostile title cannot break out of the document title', async () => {
  const result = await auditFixture(HOSTILE);
  const html = renderHtml(result);
  const title = html.slice(html.indexOf('<title>'), html.indexOf('</title>'));
  assert.doesNotMatch(title, /<script/i);
});

test('branding options are applied', async () => {
  const result = await auditFixture(HOSTILE);
  const html = renderHtml(result, {
    brand: 'Acme Digital',
    accent: '#7c3aed',
    preparedFor: 'Client Co',
    preparedBy: 'A. Consultant',
  });

  assert.match(html, /Acme Digital — AI Visibility Audit/);
  assert.match(html, /--accent:#7c3aed/);
  assert.match(html, /Prepared for Client Co/);
  assert.match(html, /by A\. Consultant/);
  assert.doesNotMatch(html, /Citable — AI Visibility Audit/);
});

test('branding values are escaped too', async () => {
  const result = await auditFixture(HOSTILE);
  const html = renderHtml(result, { brand: '<script>alert(1)</script>', preparedFor: '"><b>x' });
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /"><b>x/);
});

test('a free-tier report withholds the generated fixes', async () => {
  const result = await auditFixture(HOSTILE, { tier: 'free' });
  const html = renderHtml(result);

  assert.doesNotMatch(html, /Ready-to-ship fixes/);
  assert.match(html, /included in Citable Pro/);
  assert.match(html, /Findings — top \d/);
});

test('blocked crawlers are shown with the rule responsible', async () => {
  const result = await auditFixture(HOSTILE, {
    robots: 'User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n',
  });
  const html = renderHtml(result);
  assert.match(html, /PerplexityBot/);
  assert.match(html, /Blocked/);
  assert.match(html, /Disallow: \//);
});

test('a report with no robots.txt explains that nothing is blocked', async () => {
  const server = http.createServer((req, res) => {
    if (req.url !== '/') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HOSTILE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const result = await auditUrl(`http://127.0.0.1:${server.address().port}/`, {
    tier: 'pro',
    fetchOptions: ALLOW_PRIVATE,
  });
  server.close();

  const html = renderHtml(result);
  assert.match(html, /No robots\.txt was found, so nothing is blocked/);
});

/* ------------------------------------------------- whole-site HTML report */

import { auditSite, urlsFromSitemap } from '../src/core/audit.js';
import { renderSiteHtml } from '../src/core/report.js';

/** A small site where one shared template carries the same defect everywhere. */
async function startSite() {
  let port;
  const page = (path) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${path} — Northwind</title>
<meta name="description" content="A page about ${path} with enough description text to satisfy the length check comfortably.">
</head><body><h1>${path}</h1>
<p>${`Body copy for ${path} that runs long enough to count as genuine readable content. `.repeat(20)}</p>
</body></html>`;

  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      // The template-level defect: every page is blocked from Perplexity.
      return res.end('User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
    }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(
        `<urlset><url><loc>http://127.0.0.1:${port}/a</loc></url><url><loc>http://127.0.0.1:${port}/b</loc></url></urlset>`,
      );
    }
    if (req.url === '/llms.txt') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(req.url));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return { origin: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

test('the site report leads with issues that repeat across pages', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());

  const urls = await urlsFromSitemap(site.origin, { limit: 5, fetchOptions: ALLOW_PRIVATE });
  const rollup = await auditSite(urls, { tier: 'pro', fetchOptions: ALLOW_PRIVATE, delayMs: 0 });
  const html = renderSiteHtml(rollup, { brand: 'Acme Digital', preparedFor: 'Northwind' });

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Acme Digital — Site AI Visibility Audit/);
  assert.match(html, /Prepared for Northwind/);

  // The template-level section is the point of a site report.
  assert.match(html, /Fix these first/);
  assert.match(html, /Invisible to Perplexity|blocked by robots\.txt/);

  // Every audited page appears, with the engine it is blocked from.
  for (const url of urls) assert.ok(html.includes(url), `missing page row for ${url}`);
  assert.match(html, /PerplexityBot/);

  // Same self-contained guarantees as the single-page report.
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i);
});

test('the site verdict calls out a site-wide block', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());

  const urls = await urlsFromSitemap(site.origin, { limit: 5, fetchOptions: ALLOW_PRIVATE });
  const rollup = await auditSite(urls, { tier: 'pro', fetchOptions: ALLOW_PRIVATE, delayMs: 0 });
  const html = renderSiteHtml(rollup);

  // Every page is blocked, so the verdict should say so rather than averaging
  // it away into a mediocre score.
  assert.match(html, /Every page audited is blocked from at least one answer engine/);
});

test('unreachable pages are reported rather than silently dropped', () => {
  const rollup = {
    pagesAudited: 1,
    pagesFailed: 1,
    averageScore: 70,
    worst: null,
    best: null,
    sitewideIssues: [],
    pages: [
      { url: 'https://a.test/ok', score: 70, grade: 'C', issuesTotal: 4, crawlers: [] },
      { url: 'https://a.test/dead', error: 'Timed out after 15000ms', code: 'timeout' },
    ],
  };
  const html = renderSiteHtml(rollup);
  assert.match(html, /Could not be fetched/);
  assert.match(html, /https:\/\/a\.test\/dead/);
  assert.match(html, /Timed out/);
  assert.match(html, /1 unreachable/);
});

test('page-controlled URLs and errors are escaped in the site report', () => {
  const rollup = {
    pagesAudited: 1,
    pagesFailed: 1,
    averageScore: 50,
    worst: null,
    best: null,
    sitewideIssues: [{ id: 'x', title: '<script>alert(1)</script>', severity: 'high', pages: 1, fix: '"><b>y' }],
    pages: [
      { url: 'https://a.test/<script>alert(1)</script>', score: 50, grade: 'D', issuesTotal: 1, crawlers: [] },
      { url: 'https://a.test/bad', error: '<img src=x onerror=alert(2)>', code: 'error' },
    ],
  };
  const html = renderSiteHtml(rollup);

  // The property that matters is that page-controlled text cannot introduce
  // live markup. Searching for the substring "onerror=" is the wrong proxy —
  // it appears harmlessly inside "&lt;img src=x onerror=alert(2)&gt;", which
  // renders as inert text. Assert on tag delimiters instead.
  assert.doesNotMatch(html, /<script/i, 'no script element may appear');
  assert.doesNotMatch(html, /<img\b/i, 'no img element may be introduced by page content');
  assert.doesNotMatch(html, /<b>/i, 'no markup may be injected via a fix string');
  assert.match(html, /&lt;script&gt;/, 'the payload should survive as escaped text');
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/, 'the error text should be fully escaped');
});
