/**
 * The audit rules themselves.
 *
 * Two kinds of assertion here: specific behaviours that were wrong before, and
 * invariants that must hold for every check — because the scorer divides by
 * the points a category actually offered, a check that emits a malformed
 * finding silently distorts the headline number rather than failing loudly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES, SEVERITY_ORDER, runChecks } from '../src/core/checks.js';
import { scoreFindings } from '../src/core/score.js';

/** Run the checks against a page body with no network involved. */
function check(html, overrides = {}) {
  return runChecks({
    url: 'https://a.test/',
    page: {
      status: 200,
      ok: true,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: html,
      bytes: html.length,
      elapsedMs: 5,
      redirects: [],
      truncated: false,
      finalUrl: 'https://a.test/',
      ...overrides,
    },
    ...overrides.context,
  });
}

const BODY = `<h1>Widgets</h1><p>${'Widget copy that is long enough to count as real content. '.repeat(30)}</p>`;
const find = (findings, id) => findings.find((item) => item.id === id);

test('authorship in a script bundle does not count as declared authorship', () => {
  // A bundler inlining package metadata puts `"author":` inside a <script>.
  // No engine reads that as authorship; a document-wide regex accepted it.
  const html = `<html lang="en"><head><title>Widgets page here</title></head><body>${BODY}
    <script>window.__DATA__ = {"author":"webpack","dateModified":"2020-01-02","datePublished":"2020-01-01"};</script>
    </body></html>`;

  const { findings } = check(html);
  assert.equal(find(findings, 'author').severity, 'low');
  assert.equal(find(findings, 'freshness').severity, 'low');
});

test('authorship and dates declared in JSON-LD do count', () => {
  const html = `<html lang="en"><head><title>Widgets page here</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article",
      "author":{"@type":"Person","name":"Ada"},"datePublished":"2026-01-01"}</script>
    </head><body>${BODY}</body></html>`;

  const { findings } = check(html);
  assert.equal(find(findings, 'author').severity, 'pass');
  assert.equal(find(findings, 'freshness').severity, 'pass');
});

test('a meta author and a visible time element also count', () => {
  const html = `<html lang="en"><head><title>Widgets page here</title>
    <meta name="author" content="Ada Lovelace"></head>
    <body>${BODY}<time datetime="2026-02-01">February 2026</time></body></html>`;

  const { findings } = check(html);
  assert.equal(find(findings, 'author').severity, 'pass');
  const freshness = find(findings, 'freshness');
  assert.equal(freshness.severity, 'pass');
  assert.match(freshness.detail, /time/);
});

test('a Last-Modified header is a freshness signal', () => {
  const html = `<html lang="en"><head><title>Widgets page here</title></head><body>${BODY}</body></html>`;
  const { findings } = check(html, { headers: { 'content-type': 'text/html', 'last-modified': 'Mon, 02 Feb 2026 00:00:00 GMT' } });
  assert.equal(find(findings, 'freshness').severity, 'pass');
});

/* ------------------------------------------------------------- invariants */

const SAMPLE_PAGES = [
  '',
  '<html></html>',
  `<html lang="en"><head><title>Widgets page here</title></head><body>${BODY}</body></html>`,
  '<html><head><title>App</title></head><body><div id="root"></div><script>var a=1;</script></body></html>',
  `<html lang="en"><head><title>T</title><script type="application/ld+json">{ broken json }</script></head><body>${BODY}</body></html>`,
];

/**
 * Companion-file states the sample pages never reach on their own. Without
 * these, the "a pass awards full marks" invariant below never runs against the
 * robots/sitemap/llms branches — and that is exactly where it was violated.
 */
const COMPANION_STATES = [
  {},
  {
    robots: { found: true, body: 'User-agent: *\nAllow: /\n', status: 200, url: 'r' },
    sitemap: { found: true, body: '<urlset></urlset>', status: 200, url: 's' },
    llms: { found: false, body: '', status: 404, url: 'l' },
  },
  {
    robots: { found: true, body: 'User-agent: *\nAllow: /\nSitemap: https://a.test/sitemap.xml\n', status: 200, url: 'r' },
    sitemap: { found: true, body: '<urlset></urlset>', status: 200, url: 's' },
    llms: { found: true, body: '# Site\n\n> Summary.\n\n- [A](https://a.test/a): a\n- [B](https://a.test/b): b\n- [C](https://a.test/c): c\n', status: 200, url: 'l' },
  },
  {
    robots: { found: true, body: 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n', status: 200, url: 'r' },
    sitemap: { found: false, body: '', status: 404, url: 's' },
    llms: { found: true, body: 'thin file with no heading or links', status: 200, url: 'l' },
  },
];

/** Every page crossed with every companion-file state. */
function everyScenario() {
  const out = [];
  for (const html of SAMPLE_PAGES) {
    for (const companions of COMPANION_STATES) {
      out.push(
        runChecks({
          url: 'https://a.test/',
          page: {
            status: 200,
            ok: true,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: html,
            bytes: html.length,
            elapsedMs: 5,
            redirects: [],
            truncated: false,
            finalUrl: 'https://a.test/',
          },
          ...companions,
        }),
      );
    }
  }
  return out;
}

test('every finding is well-formed', () => {
  for (const { findings } of everyScenario()) {
    assert.ok(findings.length > 0, 'checks should always produce findings');

    for (const item of findings) {
      assert.ok(item.id, 'finding needs an id');
      assert.ok(CATEGORIES[item.category], `unknown category: ${item.category}`);
      assert.ok(SEVERITY_ORDER.includes(item.severity), `unknown severity: ${item.severity}`);
      assert.ok(item.title, `${item.id} needs a title`);
      assert.ok(item.detail, `${item.id} needs a detail`);

      // The scorer divides by these, so a NaN here silently poisons the score.
      assert.ok(Number.isFinite(item.earned), `${item.id} earned must be finite`);
      assert.ok(Number.isFinite(item.max), `${item.id} max must be finite`);
      assert.ok(item.max > 0, `${item.id} max must be positive`);
      assert.ok(item.earned >= 0 && item.earned <= item.max, `${item.id} earned ${item.earned} out of range 0..${item.max}`);

      // A passing check must award full marks. Otherwise a report can show
      // every check green while the score sits below 100, with no open finding
      // accounting for the gap.
      if (item.severity === 'pass') {
        assert.equal(item.earned, item.max, `${item.id} passed but scored ${item.earned} of ${item.max}`);
      }
      // Conversely, a finding that withholds points must say so.
      if (item.earned < item.max) {
        assert.notEqual(item.severity, 'pass', `${item.id} withholds points but is reported as a pass`);
      }
    }
  }
});

test('no finding id is emitted twice in one run', () => {
  for (const { findings } of everyScenario()) {
    const ids = findings.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate finding ids: ${ids.join(', ')}`);
  }
});

test('scores stay within 0..100 for every scenario', () => {
  for (const { findings } of everyScenario()) {
    const scored = scoreFindings(findings);
    assert.ok(Number.isFinite(scored.score), 'score must be a number');
    assert.ok(scored.score >= 0 && scored.score <= 100, `score out of range: ${scored.score}`);
    assert.ok(['A', 'B', 'C', 'D', 'F'].includes(scored.grade));

    for (const category of Object.values(scored.categories)) {
      assert.ok(category.earned >= 0 && category.earned <= category.max, `${category.key} out of range`);
    }
  }
});

test('category weights sum to 100', () => {
  const total = Object.values(CATEGORIES).reduce((sum, category) => sum + category.weight, 0);
  assert.equal(total, 100);
});

test('a sitemap that is not declared in robots.txt is a finding, not a pass', () => {
  const html = `<html lang="en"><head><title>Widgets page here</title></head><body>${BODY}</body></html>`;
  const { findings } = runChecks({
    url: 'https://a.test/',
    page: { status: 200, ok: true, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html, bytes: html.length, elapsedMs: 5, redirects: [], truncated: false, finalUrl: 'https://a.test/' },
    robots: { found: true, body: 'User-agent: *\nAllow: /\n', status: 200, url: 'r' },
    sitemap: { found: true, body: '<urlset></urlset>', status: 200, url: 's' },
    llms: { found: false, body: '', status: 404, url: 'l' },
  });

  const sitemap = find(findings, 'sitemap');
  assert.equal(sitemap.severity, 'low');
  assert.match(sitemap.title, /not declared in robots\.txt/);
  assert.ok(sitemap.fix, 'a withheld-point finding needs a fix');
});

test('a page that passes everything scores near the top', () => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>How do AI crawlers read a page?</title>
<meta name="description" content="A practical explanation of how AI crawlers fetch and parse pages, and what that means for citation.">
<link rel="canonical" href="https://a.test/">
<meta property="og:title" content="How do AI crawlers read a page?">
<meta property="og:description" content="How AI crawlers read pages.">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
{"@type":"Organization","name":"A Co","url":"https://a.test"},
{"@type":"Article","headline":"How do AI crawlers read a page?","author":{"@type":"Person","name":"Ada"},
 "datePublished":"2026-01-01","dateModified":"2026-02-01"}]}</script>
</head><body>
<h1>How do AI crawlers read a page?</h1>
<p>AI crawlers fetch the raw HTML and parse the text without running JavaScript, so client-rendered content is invisible to them.</p>
<h2>What does a crawler download?</h2>
<ul><li>The bytes your server returns</li><li>Nothing more</li></ul>
<p>${'It downloads exactly what the server returned and never executes scripts. '.repeat(25)}</p>
<h2>How should I structure a page?</h2>
<p>${'Structure each section so it answers one question completely and quotably. '.repeat(25)}</p>
<p>See <a href="https://www.rfc-editor.org/rfc/rfc9309.html">RFC 9309</a> and <a href="https://schema.org/">schema.org</a>.</p>
</body></html>`;

  const { findings } = check(html);
  const scored = scoreFindings(findings);
  assert.ok(scored.score >= 80, `expected a strong score, got ${scored.score}`);
  assert.equal(scored.counts.critical, 0);
});

/* ------------------------------- client-rendering vs merely short content */

// An ordinary analytics snippet. Large enough to dominate a short page's bytes,
// which is exactly the situation that used to be misread as client rendering.
const ANALYTICS = `<script>${'window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}'.repeat(30)}</script>`;

test('an empty mount element is reported as client-rendered', () => {
  const { findings } = check(`<html><head><title>App</title></head><body><div id="root"></div><script>${'var a=1;'.repeat(800)}</script></body></html>`);
  const finding = find(findings, 'js-rendered');
  assert.equal(finding.severity, 'critical');
  assert.match(finding.title, /rendered by JavaScript/);
});

test('a shell with no recognisable mount id is still reported', () => {
  // The mount-element pattern only knows the common framework ids, so the
  // absence of any prose markup has to carry the verdict on its own.
  const { findings } = check(`<html><head><title>App</title></head><body><div class="application-container"></div><script>${'var a=1;'.repeat(800)}</script></body></html>`);
  assert.equal(find(findings, 'js-rendered').severity, 'critical');
});

test('a short but server-rendered page is thin, not client-rendered', () => {
  // The page is fully present in the HTML; it is simply short. Diagnosing this
  // as client rendering sends the reader to re-architect a site that is fine,
  // and the suggested fix — server-render it — is already done.
  const { findings } = check(`<!doctype html><html lang="en"><head><title>Contact us</title></head><body>
    <h1>Contact</h1>
    <p>Call us on 0800 000 000, or email hello@example.com. We are open Monday to Friday.</p>
    <p>We reply to everything within one working day.</p>${ANALYTICS}</body></html>`);

  const finding = find(findings, 'js-rendered');
  assert.notEqual(finding.severity, 'critical');
  assert.match(finding.title, /[Tt]hin/);
  assert.doesNotMatch(finding.fix, /pre-render|Server-render/);
});

test('a form-driven page counts as server-rendered content', () => {
  const { findings } = check(`<!doctype html><html lang="en"><head><title>Sign in</title></head><body>
    <h1>Sign in</h1><form><label>Email</label><input><button>Sign in</button></form>
    <p>Forgotten your password? We will email you a reset link.</p>${ANALYTICS}</body></html>`);
  assert.notEqual(find(findings, 'js-rendered').severity, 'critical');
});

test('script share is reported as evidence but does not decide the verdict', () => {
  // Two pages with near-identical script ratios and different verdicts: the
  // ratio describes the page, the missing markup diagnoses it.
  const shell = check(`<html><body><div id="root"></div>${ANALYTICS}</body></html>`).findings;
  const short = check(`<html><body><h1>Hi</h1><p>A short but genuine page of server-rendered copy.</p>${ANALYTICS}</body></html>`).findings;

  assert.equal(find(shell, 'js-rendered').severity, 'critical');
  assert.notEqual(find(short, 'js-rendered').severity, 'critical');
  for (const findings of [shell, short]) {
    assert.match(find(findings, 'js-rendered').evidence, /% (of the document is <script>|script)/);
  }
});

/* ------------------------------------------------- outbound citations */

const CITE_BODY = `<h1>T</h1><p>${'Long enough body copy to be treated as real content on this page. '.repeat(30)}</p>`;

/** Run the citation check for a page at `url` carrying `links`. */
function citations(links, url = 'https://acme.com/post') {
  const html = `<!doctype html><html lang="en"><head><title>A page about things</title></head><body>${CITE_BODY}${links}</body></html>`;
  const { findings } = runChecks({
    url,
    page: {
      body: html, status: 200, ok: true, headers: { 'content-type': 'text/html; charset=utf-8' },
      elapsedMs: 5, bytes: html.length, redirects: [], truncated: false, finalUrl: url,
    },
  });
  return find(findings, 'citations');
}

test('genuine external sources count as citations', () => {
  const finding = citations('<a href="https://rfc-editor.org/x">RFC</a><a href="https://schema.org/y">schema</a>');
  assert.equal(finding.severity, 'pass');
});

test('a site linking to itself is not citing a source', () => {
  // Each of these is the same site under a different hostname, so counting
  // them lets a page that cites nothing pass an authority check on its own
  // navigation.
  for (const [label, links] of [
    ['own subdomains', '<a href="https://blog.acme.com/a">Blog</a><a href="https://docs.acme.com/b">Docs</a>'],
    ['www vs apex', '<a href="https://www.acme.com/a">A</a><a href="https://www.acme.com/b">B</a>'],
  ]) {
    assert.notEqual(citations(links).severity, 'pass', `${label} should not count`);
  }
});

test('social profile links are self-promotion, not corroboration', () => {
  const finding = citations('<a href="https://twitter.com/acme">X</a><a href="https://linkedin.com/company/acme">In</a>');
  assert.notEqual(finding.severity, 'pass');
});

test('registrable domains are compared under multi-part public suffixes', () => {
  // Under co.uk the last two labels are the suffix itself, so a naive
  // last-two-labels comparison makes every .co.uk site look like one site.
  const sameSite = citations(
    '<a href="https://blog.acme.co.uk/a">Blog</a><a href="https://shop.acme.co.uk/b">Shop</a>',
    'https://acme.co.uk/post',
  );
  assert.notEqual(sameSite.severity, 'pass', 'sibling subdomains of one .co.uk site');

  const different = citations(
    '<a href="https://bbc.co.uk/news">BBC</a><a href="https://gov.uk/guidance">GOV</a>',
    'https://acme.co.uk/post',
  );
  assert.equal(different.severity, 'pass', 'genuinely different .uk organisations');
});
