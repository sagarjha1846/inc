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

  // Strip the one <script>-free stylesheet and check no scripts exist at all.
  assert.doesNotMatch(html, /<script/i, 'the report should contain no script tags whatsoever');
  assert.doesNotMatch(html, /onerror=/i);

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
