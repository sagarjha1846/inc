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
