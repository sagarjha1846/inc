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
import { renderHtml, renderMarkdown } from '../src/core/report.js';

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
import { renderSiteHtml, renderSiteMarkdown } from '../src/core/report.js';

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

test('the site rollup counts recurrence over complete findings, whatever the tier', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());
  const urls = await urlsFromSitemap(site.origin, { limit: 10, fetchOptions: ALLOW_PRIVATE });

  const pro = await auditSite(urls, { tier: 'pro', delayMs: 0, fetchOptions: ALLOW_PRIVATE });
  const free = await auditSite(urls, { tier: 'free', delayMs: 0, fetchOptions: ALLOW_PRIVATE });

  // The free tier limits what is listed, never what is measured. An issue
  // ranking top-three on one page and fourth on another must not be counted as
  // affecting fewer pages than it does.
  assert.equal(free.sitewideIssuesTotal, pro.sitewideIssues.length);
  assert.ok(free.sitewideIssuesWithheld > 0, 'this fixture has more issues than the free limit');
  assert.equal(free.sitewideIssues.length, pro.sitewideIssues.length - free.sitewideIssuesWithheld);

  for (const shown of free.sitewideIssues) {
    const full = pro.sitewideIssues.find((issue) => issue.id === shown.id);
    assert.equal(shown.pages, full.pages, `${shown.id} pages-affected must match the full audit`);
  }

  // The paid detail still has to be withheld.
  for (const page of free.pages) {
    assert.ok(page.issues.length <= 3);
    assert.equal(page.generated, undefined);
  }
});

test('a partial template list says so instead of reading as complete', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());
  const urls = await urlsFromSitemap(site.origin, { limit: 10, fetchOptions: ALLOW_PRIVATE });
  const free = await auditSite(urls, { tier: 'free', delayMs: 0, fetchOptions: ALLOW_PRIVATE });

  // "Do these first" over a truncated table invites the reader to work through
  // it and believe the template is then clean.
  const markdown = renderSiteMarkdown(free);
  assert.match(markdown, new RegExp(`Showing 3 of ${free.sitewideIssuesTotal} template-level issues`));

  const html = renderSiteHtml(free);
  assert.match(html, new RegExp(`Showing 3 of ${free.sitewideIssuesTotal} template-level issues`));
});

test('a branding colour cannot inject into the report it styles', async () => {
  // `accent` is the one caller-supplied value that lands in a CSS context, so
  // the HTML escaping every other string gets does nothing for it. Interpolated
  // raw it closed the <style> block and put a <script> into a document an
  // agency emails to a client, and it could pull in an external stylesheet —
  // breaking the self-contained, no-outbound-requests property this report is
  // sold on.
  const { renderHtml, renderSiteHtml, isSafeAccent } = await import('../src/core/report.js');
  const result = await auditUrl('https://acme.test/p', {
    tier: 'pro',
    fetchOptions: {
      fetchImpl: async () => new Response(
        `<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>W</h1><p>${'copy '.repeat(60)}</p></main></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
    },
  });
  const rollup = { pagesAudited: 1, pagesFailed: 0, averageScore: result.score, worst: result, best: result, sitewideIssues: [], pages: [result] };

  for (const accent of [
    'red</style><script>alert(1)</script><style>',
    'red;} @import url(//evil.test/x.css); .y{',
    'red}body{display:none}.x{color:red',
    'url(//evil.test/track.png)',
    'expression(alert(1))',
  ]) {
    assert.equal(isSafeAccent(accent), false, `${accent} should not be accepted`);
    for (const [label, html] of [['page', renderHtml(result, { accent })], ['site', renderSiteHtml(rollup, { accent })]]) {
      assert.doesNotMatch(html, /<script>alert/, `${label}: script injected via accent`);
      assert.doesNotMatch(html, /@import/, `${label}: external stylesheet pulled in via accent`);
      assert.doesNotMatch(html, /display:none\}/, `${label}: layout overridden via accent`);
      assert.doesNotMatch(html, /url\(\/\/evil/, `${label}: external request via accent`);
    }
  }

  // The colours people actually pass must survive, or the fix breaks branding.
  for (const accent of ['#7c3aed', '#fff', '#0d9488ff', 'rebeccapurple', 'rgb(124 58 237)', 'hsl(258 90% 66%)']) {
    assert.equal(isSafeAccent(accent), true, `${accent} is a legitimate colour`);
    assert.ok(renderHtml(result, { accent }).includes(`--accent:${accent}`), `${accent} should reach the stylesheet`);
  }
});

test('a brand name cannot inject into the Markdown report it labels', async () => {
  // `renderMarkdown` and `renderSiteMarkdown` are exported library functions,
  // documented for embedding — a natural build on top of this package is a
  // dashboard where a client's own display name becomes `brand`, at which
  // point it is no longer trusted the way an operator's own CLI flag is. Left
  // raw, a `<script>` in it rides straight through: GitHub and most Markdown
  // renderers pass inline HTML through unescaped. A Markdown link syntax
  // becomes a clickable phishing link sitting inside what reads as this
  // product's own upsell line ("… included in [Renew now](evil) Pro.").
  const result = await auditUrl('https://acme.test/page', {
    tier: 'free',
    fetchOptions: {
      fetchImpl: async (url) => new Response(
        String(url).endsWith('/robots.txt')
          ? 'User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n'
          : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Widgets guide</title>`
            + `<meta name="description" content="A guide to widgets and their maintenance."></head>`
            + `<body><main><h1>Widgets</h1><p>${'copy '.repeat(120)}</p></main></body></html>`,
        {
          status: 200,
          headers: { 'content-type': String(url).endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8' },
        },
      ),
    },
  });
  const rollup = { pagesAudited: 1, pagesFailed: 0, averageScore: result.score, worst: result, best: result, sitewideIssues: [], pages: [result] };

  for (const brand of [
    '[Buy fake key here](https://evil.test/phish)',
    '<script>alert(1)</script>',
    'Acme\n```\ninjected fenced block\n```\nCorp',
    '![x](https://evil.test/x.png "onerror")',
  ]) {
    const md = renderMarkdown(result, { brand });
    const siteMd = renderSiteMarkdown(rollup, { brand });
    for (const [label, doc] of [['page', md], ['site', siteMd]]) {
      // A link is only live if its closing bracket is an *unescaped* `]`
      // immediately followed by `(`. `\]( ` is inert text to any CommonMark
      // parser, so the check has to look for the dangerous form specifically
      // rather than a substring the fix's own escaping is expected to contain.
      assert.doesNotMatch(doc, /(?<!\\)\]\(https:\/\/evil\.test/, `${label}: brand became a live link`);
      assert.doesNotMatch(doc, /(?<!\\)<script(?:\\)?>alert/, `${label}: brand became a live script tag`);
      const fenceCount = (doc.match(/^```/gm) || []).length;
      assert.equal(fenceCount % 2, 0, `${label}: brand broke fence balance for ${JSON.stringify(brand)}`);
    }
  }

  // An ordinary brand must render exactly as before — this cannot cost normal
  // white-labelling anything.
  assert.match(renderMarkdown(result, { brand: 'Acme Digital' }), /Generated by Acme Digital\./);
});

test('the audited page itself cannot inject into the Markdown report describing it', async () => {
  // `brand` is at least chosen by whoever runs the audit. A finding's `title`
  // and `detail` are not: several checks quote the page verbatim into them —
  // the meta description here, the first H1 there, also the declared `lang`
  // and the canonical href elsewhere — so the page being audited is the
  // attacker, and the payload rides in as ordinary site content rather than
  // a CLI flag. Evidence quotes already go through `fenced()` and stay inert
  // inside a code block; this covers the fields interpolated as plain prose.
  const malDescription =
    'Free money [click here](https://evil.test/phish) and read on for the rest of a description long enough to be well-sized.';
  const malH1 = 'Guide [click here](https://evil.test/h1) to widgets';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<title>Widgets guide</title>`
    + `<meta name="description" content="${malDescription}"></head>`
    + `<body><main><h1>${malH1}</h1><p>${'copy '.repeat(120)}</p></main></body></html>`;

  const result = await auditUrl('https://acme.test/page', {
    tier: 'pro',
    fetchOptions: {
      fetchImpl: async (url) => new Response(
        String(url).endsWith('/robots.txt') ? 'User-agent: *\nAllow: /\n' : html,
        { status: 200, headers: { 'content-type': String(url).endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8' } },
      ),
    },
  });
  const rollup = { pagesAudited: 1, pagesFailed: 0, averageScore: result.score, worst: result, best: result, sitewideIssues: [], pages: [result] };

  // A well-formed description and a single H1 both score full marks, so both
  // findings land in `result.passes` (the "Already correct" section) rather
  // than `result.issues` — confirm the payload actually made it into one of
  // the two lists unescaped at the source, so a passing assertion below
  // proves the renderer escaped it rather than the payload never landing.
  const rawTitlesAndDetails = [...result.issues, ...(result.passes || [])]
    .flatMap((item) => [item.title, item.detail])
    .join('\n');
  assert.match(rawTitlesAndDetails, /\]\(https:\/\/evil\.test/, 'fixture did not actually reach a finding — test would be vacuous');

  // `includeGenerated: false` excludes the "Ready-to-ship fixes" section,
  // which legitimately quotes the same page content raw — it's the literal
  // llms.txt/JSON-LD file the user is meant to copy, and it stays inert
  // through `fenced()`'s code-block mechanism rather than mdText()'s. This
  // test is about the findings prose, which has no such fence to protect it.
  for (const doc of [
    renderMarkdown(result, { includeGenerated: false }),
    renderSiteMarkdown(rollup),
  ]) {
    assert.doesNotMatch(doc, /(?<!\\)\]\(https:\/\/evil\.test/, 'page content became a live Markdown link');
  }
});
