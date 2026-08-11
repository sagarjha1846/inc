import test from 'node:test';
import assert from 'node:assert/strict';

import { auditUrl, urlsFromSitemap } from '../src/core/audit.js';
import { renderMarkdown, renderTerminal } from '../src/core/report.js';

/** Build a fetch stub that serves a fixed map of URL → {status, body, headers}. */
function stubFetch(routes) {
  return async (url) => {
    const route = routes[url] ?? routes[url.replace(/\/$/, '')];
    if (!route) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(route.body ?? '', {
      status: route.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...(route.headers || {}) },
    });
  };
}

const GOOD_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>How to configure robots.txt for AI crawlers</title>
  <meta name="description" content="A practical guide to allowing AI answer engines to crawl and cite your site, covering GPTBot, ClaudeBot, PerplexityBot and Google-Extended in detail.">
  <link rel="canonical" href="https://good.test/guide">
  <meta property="og:title" content="How to configure robots.txt for AI crawlers">
  <meta property="og:description" content="A practical guide to allowing AI answer engines to crawl your site.">
  <meta name="author" content="Ada Lovelace">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@graph":[
    {"@type":"Organization","name":"Good Co","url":"https://good.test"},
    {"@type":"Article","headline":"How to configure robots.txt for AI crawlers","datePublished":"2026-01-01","dateModified":"2026-02-01","author":{"@type":"Person","name":"Ada Lovelace"}}
  ]}
  </script>
</head>
<body>
  <h1>How to configure robots.txt for AI crawlers</h1>
  <p>Allowing AI crawlers is a two line change in robots.txt, and it decides whether answer engines may quote your pages at all. This guide walks through each crawler, what it does, and the exact directives to publish today.</p>
  <h2>What is an AI crawler?</h2>
  <p>${'An AI crawler fetches pages so a model can read them. '.repeat(20)}</p>
  <h2>Which crawlers should I allow?</h2>
  <ul><li>GPTBot</li><li>ClaudeBot</li><li>PerplexityBot</li></ul>
  <p>${'Allow the citation crawlers first because they drive referral traffic. '.repeat(20)}</p>
  <h2>How do I verify the change?</h2>
  <p>${'Fetch your robots file and confirm each user agent group resolves as expected. '.repeat(20)}</p>
  <p>See the <a href="https://www.rfc-editor.org/rfc/rfc9309.html">robots exclusion protocol</a> and the <a href="https://schema.org/Article">schema.org reference</a>.</p>
</body>
</html>`;

const SPA_PAGE = `<!doctype html>
<html>
<head><title>App</title>
<script>${'var padding = "x";'.repeat(400)}</script>
</head>
<body><div id="root"></div>
<script>${'var more = "y";'.repeat(400)}</script>
</body>
</html>`;

test('a well-built page scores highly and reports no blocked crawlers', async () => {
  const result = await auditUrl('https://good.test/guide', {
    fetchOptions: {
      fetchImpl: stubFetch({
        'https://good.test/guide': { body: GOOD_PAGE },
        'https://good.test/robots.txt': {
          body: 'User-agent: *\nAllow: /\n\nSitemap: https://good.test/sitemap.xml\n',
          headers: { 'content-type': 'text/plain' },
        },
        'https://good.test/llms.txt': {
          body: '# Good Co\n\n> Guides about AI crawlers.\n\n## Pages\n\n- [Guide](https://good.test/guide): The guide.\n- [About](https://good.test/about): About us.\n- [Docs](https://good.test/docs): Docs.\n',
          headers: { 'content-type': 'text/plain' },
        },
        'https://good.test/sitemap.xml': {
          body: '<urlset><url><loc>https://good.test/guide</loc></url></urlset>',
          headers: { 'content-type': 'application/xml' },
        },
      }),
    },
  });

  assert.ok(result.score >= 85, `expected a high score, got ${result.score}`);
  assert.equal(result.grade === 'A' || result.grade === 'B', true);
  assert.ok(result.crawlers.every((crawler) => crawler.allowed));
  assert.ok(result.stats.words > 300);
  assert.equal(result.counts.critical, 0);
});

test('a JS-only page is flagged critical for unreadable content', async () => {
  const result = await auditUrl('https://spa.test/', {
    fetchOptions: {
      fetchImpl: stubFetch({
        'https://spa.test/': { body: SPA_PAGE },
      }),
    },
  });

  const jsFinding = result.issues.find((issue) => issue.id === 'js-rendered');
  assert.ok(jsFinding, 'expected the JS-rendering finding to be surfaced');
  assert.equal(jsFinding.severity, 'critical');
  assert.ok(result.score < 60, `expected a low score, got ${result.score}`);
  assert.match(result.verdict, /Not citable/);
});

test('robots.txt blocking AI crawlers produces a critical access finding', async () => {
  const result = await auditUrl('https://blocked.test/page', {
    tier: 'pro',
    fetchOptions: {
      fetchImpl: stubFetch({
        'https://blocked.test/page': { body: GOOD_PAGE },
        'https://blocked.test/robots.txt': {
          body: 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: Claude-SearchBot\nDisallow: /\n',
          headers: { 'content-type': 'text/plain' },
        },
      }),
    },
  });

  const blocking = result.issues.find((issue) => issue.id === 'ai-crawlers-blocked');
  assert.ok(blocking);
  assert.equal(blocking.severity, 'critical');
  assert.ok(blocking.evidence.includes('PerplexityBot'));
  assert.equal(result.categories.access.earned < result.categories.access.max, true);
});

test('free tier withholds findings and generators; pro tier includes both', async () => {
  const routes = {
    'https://spa.test/': { body: SPA_PAGE },
  };

  const free = await auditUrl('https://spa.test/', { fetchOptions: { fetchImpl: stubFetch(routes) } });
  assert.equal(free.tier, 'free');
  assert.ok(free.issues.length <= 3);
  assert.ok(free.issuesWithheld > 0);
  assert.equal(free.generated, undefined);
  assert.ok(free.upgrade.message.includes('Pro'));

  const pro = await auditUrl('https://spa.test/', { tier: 'pro', fetchOptions: { fetchImpl: stubFetch(routes) } });
  assert.equal(pro.tier, 'pro');
  assert.equal(pro.issues.length, pro.issuesTotal);
  assert.equal(pro.issuesWithheld, 0);
  assert.ok(pro.generated.robotsTxt.includes('User-agent: PerplexityBot'));
  assert.ok(pro.generated.llmsTxt.startsWith('# '));
  assert.ok(pro.passes.length > 0);
});

test('generated robots patch names every crawler that is currently blocked', async () => {
  const result = await auditUrl('https://blocked.test/page', {
    tier: 'pro',
    fetchOptions: {
      fetchImpl: stubFetch({
        'https://blocked.test/page': { body: GOOD_PAGE },
        'https://blocked.test/robots.txt': { body: 'User-agent: *\nDisallow: /\n', headers: { 'content-type': 'text/plain' } },
      }),
    },
  });
  assert.match(result.generated.robotsTxt, /<-- currently blocked/);
  assert.match(result.generated.robotsTxt, /Sitemap: https:\/\/blocked\.test\/sitemap\.xml/);
});

test('snippet-suppressing directives are caught in headers as well as meta', async () => {
  const result = await auditUrl('https://noindex.test/', {
    tier: 'pro',
    fetchOptions: {
      fetchImpl: stubFetch({
        'https://noindex.test/': { body: GOOD_PAGE, headers: { 'x-robots-tag': 'noindex, nosnippet' } },
      }),
    },
  });
  const finding = result.issues.find((issue) => issue.id === 'snippet-directives');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.match(finding.evidence, /X-Robots-Tag/);
});

test('an HTML error page served at /robots.txt is treated as no robots.txt', async () => {
  const result = await auditUrl('https://soft404.test/', {
    tier: 'pro',
    fetchOptions: {
      fetchImpl: stubFetch({
        'https://soft404.test/': { body: GOOD_PAGE },
        'https://soft404.test/robots.txt': { body: '<!doctype html><html><body>Page not found</body></html>' },
      }),
    },
  });
  assert.ok(result.issues.some((issue) => issue.id === 'robots-missing'));
});

test('reports render for both tiers without throwing', async () => {
  const result = await auditUrl('https://good.test/guide', {
    tier: 'pro',
    fetchOptions: {
      fetchImpl: stubFetch({
        'https://good.test/guide': { body: GOOD_PAGE },
        'https://good.test/robots.txt': { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
      }),
    },
  });

  const markdown = renderMarkdown(result);
  assert.match(markdown, /# AI Visibility Audit/);
  assert.match(markdown, /Score breakdown/);
  assert.match(markdown, /llms\.txt/);

  const terminal = renderTerminal(result, { color: false });
  assert.match(terminal, /\/100/);
});

test('urlsFromSitemap expands a sitemap index one level deep', async () => {
  const urls = await urlsFromSitemap('https://good.test', {
    limit: 5,
    fetchOptions: {
      fetchImpl: stubFetch({
        'https://good.test/sitemap.xml': {
          body: '<sitemapindex><sitemap><loc>https://good.test/pages.xml</loc></sitemap></sitemapindex>',
          headers: { 'content-type': 'application/xml' },
        },
        'https://good.test/pages.xml': {
          body: '<urlset><url><loc>https://good.test/a</loc></url><url><loc>https://good.test/b</loc></url></urlset>',
          headers: { 'content-type': 'application/xml' },
        },
      }),
    },
  });
  assert.deepEqual(urls, ['https://good.test/a', 'https://good.test/b']);
});

test('private and malformed hosts are refused before any request', async () => {
  await assert.rejects(() => auditUrl('http://localhost:3000/'), /private or loopback/);
  await assert.rejects(() => auditUrl('ftp://example.com/'), /Unsupported protocol/);
  await assert.rejects(() => auditUrl('http://192.168.1.1/'), /private or loopback/);
});
