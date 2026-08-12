/**
 * The fix generators.
 *
 * These produce files the reader pastes into their own site — robots.txt,
 * llms.txt, and JSON-LD that goes straight into `<head>`. That makes them the
 * highest-consequence output in the product: a defect here is not a wrong
 * number in a report, it is broken or hostile markup installed in production
 * on the reader's instruction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runChecks } from '../src/core/checks.js';
import { generateAll, generateFaqSchema, generateJsonLd, generateLlmsTxt, generateRobotsPatch } from '../src/core/generate.js';

/** Build a checks context for a page body, with no network involved. */
function context(html, url = 'https://acme.com/widgets') {
  const { ctx } = runChecks({
    url,
    page: {
      body: html, status: 200, ok: true, headers: { 'content-type': 'text/html; charset=utf-8' },
      elapsedMs: 5, bytes: html.length, redirects: [], truncated: false, finalUrl: url,
    },
  });
  return ctx;
}

const PROSE = 'A widget couples two shafts together in a way that tolerates slight misalignment. '.repeat(20);

const ORDINARY = `<!doctype html><html lang="en"><head>
<title>What is a widget?</title>
<meta name="description" content="A practical explanation of what widgets are, how they are made, and how to choose between the common types.">
</head><body><main>
<h1>What is a widget?</h1><p>${PROSE}</p>
<h2>How do I fit one?</h2><p>${PROSE}</p>
<h2>Which type should I choose?</h2><p>${PROSE}</p>
</main></body></html>`;

// The title and a heading carry entity-encoded markup. Entities are decoded
// *after* tags are stripped, so nothing upstream removes this — it arrives in
// the generator as a literal `</script>`.
const HOSTILE = `<!doctype html><html lang="en"><head>
<title>Widgets&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;</title>
</head><body><main>
<h1>Widgets</h1><p>${PROSE}</p>
<h2>What is a widget&lt;/script&gt;&lt;svg onload=alert(2)&gt;?</h2><p>${PROSE}</p>
<h2>How do I fit one?</h2><p>${PROSE}</p>
</main></body></html>`;

/** The text between a generated block's script tags. */
const innerOf = (markup) => markup.replace(/^<script[^>]*>/, '').replace(/<\/script>\s*$/, '');

test('generated JSON-LD cannot break out of the block it is pasted into', () => {
  const { markup, json } = generateJsonLd(context(HOSTILE));
  assert.ok(markup, 'expected a block to be generated');

  const inner = innerOf(markup);
  assert.doesNotMatch(inner, /<\/script/i, 'a closing tag here ends the block early on the pasting site');
  assert.ok(!inner.includes('<'), 'no raw < may survive inside an embedded script block');
  // The words "onerror" and "onload" do still appear, as inert escaped text.
  // That is correct: the page's title genuinely contains them, and the round
  // trip below depends on the value surviving. Escaping `<` is what makes them
  // harmless; removing them would corrupt the reader's own content.

  // Escaping must not cost validity: this is still JSON-LD.
  assert.doesNotThrow(() => JSON.parse(json));
  assert.equal(JSON.parse(json)['@context'], 'https://schema.org');
});

test('generated FAQ schema is escaped the same way', () => {
  const { markup, json } = generateFaqSchema(context(HOSTILE));
  assert.ok(markup, 'two question headings should yield a block');

  const inner = innerOf(markup);
  assert.doesNotMatch(inner, /<\/script/i);
  assert.ok(!inner.includes('<'));
  assert.doesNotThrow(() => JSON.parse(json));
});

test('escaping survives a round trip back to the original text', () => {
  // The escape must be reversible, or the reader ships mangled content.
  const { json } = generateJsonLd(context(HOSTILE));
  const article = JSON.parse(json)['@graph'].find((node) => node['@type'] === 'Article');
  assert.match(article.headline, /Widgets<\/script>/, 'the value itself is preserved, only its encoding changes');
});

test('an ordinary page still produces usable, valid JSON-LD', () => {
  const { markup, json } = generateJsonLd(context(ORDINARY));
  const parsed = JSON.parse(json);
  const article = parsed['@graph'].find((node) => node['@type'] === 'Article');

  assert.equal(article.headline, 'What is a widget?');
  assert.match(article.description, /A practical explanation/);
  assert.match(markup, /^<script type="application\/ld\+json">/);
  assert.match(markup, /<\/script>$/);
});

test('the robots patch allows every citation crawler and stays parseable', () => {
  const patch = generateRobotsPatch(context(ORDINARY));

  for (const token of ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'PerplexityBot']) {
    assert.match(patch, new RegExp(`User-agent: ${token}\\nAllow: /`), `${token} should be allowed`);
  }
  // Training crawlers are a separate, deliberate decision and stay commented.
  assert.match(patch, /# ?User-agent: GPTBot/);
  // Nothing in a patch whose purpose is to grant access may deny it.
  assert.doesNotMatch(patch, /^Disallow:/m);
  assert.match(patch, /Sitemap: https:\/\/acme\.com\/sitemap\.xml/);
});

test('generated llms.txt has the shape the convention expects', () => {
  const llms = generateLlmsTxt(context(ORDINARY));
  assert.match(llms, /^# /, 'a top-level heading naming the site');
  assert.match(llms, /^> /m, 'a blockquote summary');
  assert.ok((llms.match(/^- \[/gm) || []).length >= 3, 'curated links');
});

test('every generator runs on a page with almost nothing in it', () => {
  // Generators run on whatever the audit found, including near-empty pages.
  // Throwing here would fail a paid report rather than degrade it.
  const generated = generateAll(context('<html><head></head><body></body></html>'));
  assert.equal(typeof generated.robotsTxt, 'string');
  assert.equal(typeof generated.llmsTxt, 'string');
  assert.ok('markup' in generated.jsonLd);
  // Too few question headings to build an FAQ: says so rather than emitting junk.
  assert.equal(generated.faqSchema.markup, null);
  assert.match(generated.faqSchema.note, /question-style headings/);
});

/* ------------------------------- page content inside the Markdown report */

import { scoreFindings, prioritize } from '../src/core/score.js';
import { renderMarkdown } from '../src/core/report.js';

/**
 * Walk a Markdown document the way CommonMark does: a fenced block opens on a
 * run of backticks and closes only on a run at least as long. Returns the text
 * outside any fence — anything from the audited page that appears here has
 * escaped its quoting and become live Markdown.
 */
function outsideFences(md) {
  const out = [];
  let open = 0;
  for (const line of md.split('\n')) {
    const match = /^(`{3,})(.*)$/.exec(line);
    if (!open && match) {
      open = match[1].length;
      continue;
    }
    if (open && match && match[1].length >= open && !match[2].trim()) {
      open = 0;
      continue;
    }
    if (!open) out.push(line);
  }
  return { text: out.join('\n'), unterminated: open > 0 };
}

/** Render a full Markdown report for a page body. */
function report(html, url = 'https://acme.com/w') {
  const { findings, ctx } = runChecks({
    url,
    page: {
      body: html, status: 200, ok: true, headers: { 'content-type': 'text/html; charset=utf-8' },
      elapsedMs: 5, bytes: html.length, redirects: [], truncated: false, finalUrl: url,
    },
  });
  const scored = scoreFindings(findings);
  const ranked = prioritize(findings);
  return renderMarkdown({
    tier: 'pro', url, fetchedAt: '2026-01-01T00:00:00.000Z',
    http: { status: 200, responseMs: 10, bytes: html.length, redirects: [] },
    score: scored.score, grade: scored.grade, verdict: scored.verdict,
    categories: scored.categories, counts: scored.counts,
    stats: { words: ctx.words, headings: 1, scriptShare: 0, schemaTypes: [] },
    crawlers: [], issues: ranked, issuesTotal: ranked.length, issuesWithheld: 0, passes: [],
    generated: generateAll(ctx),
  });
}

test('page content cannot break out of the report’s code fences', () => {
  // Evidence quotes the page verbatim. A three-backtick fence is closed by the
  // first three backticks inside it, so a page carrying one turns the rest of
  // its own content into live Markdown in a document headed for a client.
  const fence = '`'.repeat(3);
  const html = `<!doctype html><html lang="en"><head><title>Widgets</title>
<script type="application/ld+json">
{ broken json
${fence}

## Injected heading

[a link](https://evil.test) and <img src=x onerror=alert(1)>
</script></head><body><main><h1>W</h1><p>${PROSE}</p></main></body></html>`;

  const { text, unterminated } = outsideFences(report(html));
  assert.equal(unterminated, false, 'a fence left open corrupts the rest of the document');
  assert.doesNotMatch(text, /^## Injected heading/m);
  assert.doesNotMatch(text, /<img src=x onerror/);
  assert.doesNotMatch(text, /\[a link\]/);
});

test('the evidence is still quoted faithfully, not stripped', () => {
  // Escaping by removing backticks would corrupt the quote, which has to stay
  // verifiable by hand against the page.
  const fence = '`'.repeat(3);
  const html = `<!doctype html><html lang="en"><head><title>Widgets</title>
<script type="application/ld+json">{ broken ${fence} json</script>
</head><body><main><h1>W</h1><p>${PROSE}</p></main></body></html>`;

  const md = report(html);
  assert.match(md, /broken ```? json|broken ``` json/, 'the backticks that were on the page are still shown');
});

test('an ordinary report uses ordinary fences', () => {
  // The longer fence is a response to the content, not a permanent change to
  // how every report looks.
  const md = report(ORDINARY);
  assert.match(md, /^```$/m);
  assert.doesNotMatch(md, /^`{4,}/m);
});

/* -------------------------------------------- llms.txt line structure */

test('page metadata cannot inject structure into generated llms.txt', () => {
  // og:site_name and description are attribute values, and an entity-encoded
  // newline survives attribute parsing. Interpolated raw, the value stops
  // being a value and becomes document structure in a file the reader
  // publishes at their site root.
  const html = `<!doctype html><html lang="en"><head>
<title>Acme Widgets</title>
<meta property="og:site_name" content="Acme&#10;&#10;## Injected heading&#10;&#10;Body text.">
<meta name="description" content="Widgets.&#10;&#10;# Another heading">
</head><body><main><h1>W</h1><p>${PROSE}</p><h2>Normal heading</h2><p>${PROSE}</p></main></body></html>`;

  const llms = generateLlmsTxt(context(html));
  const lines = llms.split('\n');

  // Exactly one H1, and every H2 is one the generator wrote. The H1's *text*
  // may still contain "##" characters — that is the site's own name, flattened
  // onto one line, and Markdown renders it literally. What matters is that no
  // additional heading was created out of it.
  assert.equal(lines.filter((line) => /^# /.test(line)).length, 1);
  const subheadings = lines.filter((line) => /^## /.test(line));
  assert.deepEqual(subheadings, ['## Core pages', '## Topics covered on this page', '## Optional']);

  // The summary is a single blockquote line, not a blockquote plus loose text.
  const summaryAt = lines.findIndex((line) => line.startsWith('> '));
  assert.ok(summaryAt !== -1);
  assert.equal(lines[summaryAt + 1].trim(), '');

  // Every list entry is one line: a link, then its description.
  for (const line of lines.filter((line) => line.startsWith('- ['))) {
    assert.match(line, /^- \[[^\]]*\]\([^)]*\):/, `malformed list entry: ${line}`);
  }
});

test('an enormous title does not become the document', () => {
  const html = `<!doctype html><html lang="en"><head><title>${'Widget '.repeat(200)}</title></head>
<body><main><h1>W</h1><p>${PROSE}</p></main></body></html>`;
  const llms = generateLlmsTxt(context(html));
  for (const line of llms.split('\n')) {
    assert.ok(line.length <= 260, `line runs to ${line.length} characters`);
  }
});

test('ordinary metadata is passed through unchanged', () => {
  // Flattening must not mangle a site name that was fine to begin with.
  const html = `<!doctype html><html lang="en"><head><title>What is a widget?</title>
<meta property="og:site_name" content="Acme Widgets">
<meta name="description" content="A practical explanation of what widgets are and how to choose between them.">
</head><body><main><h1>W</h1><p>${PROSE}</p></main></body></html>`;
  const llms = generateLlmsTxt(context(html));
  assert.match(llms, /^# Acme Widgets$/m);
  assert.match(llms, /^> A practical explanation of what widgets are and how to choose between them\.$/m);
});

/* ------------------------------------------------------ generated dates */

test('the generator uses a date the page actually declares', () => {
  // A date does not look like a placeholder the way CHANGE-ME does, so an
  // invented one gets pasted and shipped. Where the page states a date, that
  // is the one to carry through.
  // Only metadata cases here: a page that already declares an Article gets no
  // generated Article at all, which is the intended merge behaviour and is
  // asserted separately.
  for (const [label, head] of [
    ['article:published_time', '<meta property="article:published_time" content="2019-04-05T10:00:00Z">'],
    ['article:modified_time', '<meta property="article:modified_time" content="2019-04-05T10:00:00Z">'],
    ['og:updated_time', '<meta property="og:updated_time" content="2019-04-05T10:00:00Z">'],
  ]) {
    const html = `<!doctype html><html lang="en"><head><title>A page about widgets</title>${head}</head>
<body><main><h1>W</h1><p>${PROSE}</p></main></body></html>`;
    const { json, note } = generateJsonLd(context(html));
    const article = JSON.parse(json)['@graph'].find((node) => node['@type'] === 'Article');
    assert.equal(article.datePublished, '2019-04-05', label);
    assert.doesNotMatch(note, /default to today/, `${label}: no warning is needed when a real date was found`);
  }
});

test('a Last-Modified header counts as a declared date', () => {
  const html = `<!doctype html><html lang="en"><head><title>A page about widgets</title></head>
<body><main><h1>W</h1><p>${PROSE}</p></main></body></html>`;
  const ctx = context(html);
  ctx.page.headers['last-modified'] = 'Fri, 05 Apr 2019 10:00:00 GMT';
  const article = JSON.parse(generateJsonLd(ctx).json)['@graph'].find((n) => n['@type'] === 'Article');
  assert.equal(article.datePublished, '2019-04-05');
});

test('when no date exists the fallback is called out rather than left to pass as fact', () => {
  const html = `<!doctype html><html lang="en"><head><title>A page about widgets</title></head>
<body><main><h1>W</h1><p>${PROSE}</p></main></body></html>`;
  const { json, note } = generateJsonLd(context(html));
  const article = JSON.parse(json)['@graph'].find((node) => node['@type'] === 'Article');

  assert.match(article.datePublished, /^\d{4}-\d{2}-\d{2}$/, 'the field still has to be valid');
  assert.match(note, /datePublished and dateModified, which default to today/);
});

test('an unparseable date is ignored rather than emitted', () => {
  const html = `<!doctype html><html lang="en"><head><title>A page about widgets</title>
<meta property="article:published_time" content="last Tuesday-ish"></head>
<body><main><h1>W</h1><p>${PROSE}</p></main></body></html>`;
  const { json, note } = generateJsonLd(context(html));
  const article = JSON.parse(json)['@graph'].find((node) => node['@type'] === 'Article');
  assert.match(article.datePublished, /^\d{4}-\d{2}-\d{2}$/, 'garbage must not reach the output');
  assert.match(note, /default to today/, 'and the fallback is disclosed');
});
