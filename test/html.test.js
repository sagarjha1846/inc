import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countTag,
  decodeEntities,
  flattenJsonLd,
  headings,
  htmlLang,
  jsonLdBlocks,
  jsonLdTypes,
  linkRel,
  links,
  meta,
  parseAttributes,
  title,
  visibleText,
  wordCount,
} from '../src/core/html.js';

test('decodeEntities handles named, decimal and hex entities', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
  assert.equal(decodeEntities('caf&eacute;'), 'café');
  assert.equal(decodeEntities('no entities'), 'no entities');
  assert.equal(decodeEntities('&notreal;'), '&notreal;');
});

test('parseAttributes reads quoted, unquoted and valueless attributes', () => {
  const attrs = parseAttributes(' class="a b" id=main data-x=\'1\' hidden');
  assert.equal(attrs.class, 'a b');
  assert.equal(attrs.id, 'main');
  assert.equal(attrs['data-x'], '1');
  assert.equal(attrs.hidden, '');
});

test('visibleText drops scripts and styles but keeps prose', () => {
  const html = `
    <html><head><style>body{color:red}</style></head>
    <body><p>Hello world</p><script>var x = "should not appear";</script>
    <p>Second paragraph</p></body></html>`;
  const text = visibleText(html);
  assert.match(text, /Hello world/);
  assert.match(text, /Second paragraph/);
  assert.doesNotMatch(text, /should not appear/);
  assert.doesNotMatch(text, /color:red/);
});

test('an unclosed script does not leak JavaScript as prose', () => {
  // A real parser consumes the rest of the document as script content, so a
  // crawler sees nothing after it. Counting it would let an empty SPA shell
  // with an unclosed <script> read as hundreds of words and flip the
  // "content is JS-rendered" finding from critical to a pass.
  const shell = `<body><div id="root"></div><script>${'var padding = "word word word"; '.repeat(40)}</body>`;
  assert.equal(wordCount(visibleText(shell)), 0);

  // Content *before* the unclosed tag is still visible, because it is.
  assert.equal(wordCount(visibleText('<body><p>one two three four</p><script>junk junk junk')), 4);

  // The same applies to any element parsed as raw text.
  assert.equal(wordCount(visibleText(`<body><p>visible</p><style>${'a{color:red} '.repeat(50)}`)), 1);
});

test('noscript content counts, because a non-JS crawler can read it', () => {
  // Scripting disabled is exactly the condition these crawlers are in, and the
  // spec says noscript content is then parsed as ordinary markup. Stripping it
  // would penalise a site for shipping the fallback that makes it readable.
  const withFallback = `<body><div id="root"></div><noscript><p>${'Real fallback content here. '.repeat(10)}</p></noscript></body>`;
  assert.equal(wordCount(visibleText(withFallback)), 40);
});

test('a closing tag inside a script string ends the script, as a browser would', () => {
  // Not a bug to fix: `</script>` inside a JS string literal genuinely
  // terminates the element, which is why authors must escape it. What follows
  // is text to a real parser, so it is text to us.
  const html = '<body><script>var s = "</script>"; trailing words here</body>';
  assert.match(visibleText(html), /trailing words here/);
});

test('visibleText preserves block boundaries as newlines', () => {
  const text = visibleText('<p>One</p><p>Two</p>');
  assert.equal(text, 'One\nTwo');
});

test('wordCount counts unicode words', () => {
  assert.equal(wordCount('one two three'), 3);
  assert.equal(wordCount('café naïve'), 2);
  assert.equal(wordCount(''), 0);
});

test('meta reads name and property tags', () => {
  const html = '<meta name="description" content="A description"><meta property="og:title" content="OG">';
  assert.equal(meta(html, 'description'), 'A description');
  assert.equal(meta(html, 'og:title'), 'OG');
  assert.equal(meta(html, 'missing'), '');
});

test('jsonLdBlocks parses valid blocks and reports invalid ones', () => {
  const html = `
    <script type="application/ld+json">{"@type":"Article","headline":"Hi"}</script>
    <script type="application/ld+json">{ bad json }</script>
    <script type="text/javascript">{"@type":"NotLd"}</script>`;
  const blocks = jsonLdBlocks(html);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].ok, true);
  assert.equal(blocks[0].data['@type'], 'Article');
  assert.equal(blocks[1].ok, false);
});

test('flattenJsonLd walks @graph and nested entities', () => {
  const html = `<script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"Organization","name":"Acme"},
      {"@type":"Article","author":{"@type":"Person","name":"Ada"}}
    ]}</script>`;
  const types = jsonLdTypes(flattenJsonLd(jsonLdBlocks(html)));
  assert.ok(types.has('organization'));
  assert.ok(types.has('article'));
  assert.ok(types.has('person'));
});

test('headings returns level and text in document order', () => {
  const found = headings('<h1>Title</h1><h2>What is it?</h2><h3>Detail</h3>');
  assert.deepEqual(
    found.map((heading) => [heading.level, heading.text]),
    [
      [1, 'Title'],
      [2, 'What is it?'],
      [3, 'Detail'],
    ],
  );
});

test('links resolves relative hrefs and skips non-navigational ones', () => {
  const found = links('<a href="/a">A</a><a href="#x">X</a><a href="mailto:a@b.c">M</a><a href="https://ex.com/b">B</a>', 'https://site.test/page');
  assert.deepEqual(
    found.map((link) => link.absolute),
    ['https://site.test/a', 'https://ex.com/b'],
  );
});

test('title, linkRel, htmlLang and countTag read document-level signals', () => {
  const html = '<html lang="en"><title>My Page</title><link rel="canonical" href="https://a.test/"><ul></ul><ul></ul>';
  assert.equal(title(html), 'My Page');
  assert.deepEqual(linkRel(html, 'canonical'), ['https://a.test/']);
  assert.equal(htmlLang(html), 'en');
  assert.equal(countTag(html, 'ul'), 2);
});

/* ------------------------------------------------ control characters */

const ESC = String.fromCharCode(27);

test('control characters are removed from decoded text', () => {
  // Everything quoted from a page ends up in a terminal or a report, where
  // control characters are instructions rather than content.
  assert.equal(decodeEntities(`a&#27;[2Jb`), 'a[2Jb');
  assert.equal(decodeEntities(`a${ESC}[2Jb`), 'a[2Jb');
  assert.equal(decodeEntities('a\u0000\u0007\u007Fb'), 'ab');

  // Tab and newline are content: block structure depends on them.
  assert.equal(decodeEntities('a\tb\nc'), 'a\tb\nc');
});

test('an entity-encoded escape does not survive decoding', () => {
  // The order matters: `&#27;` only becomes a control character *during* the
  // decode, so stripping beforehand would leave the payload intact.
  const text = visibleText(`<p>Intro&#27;[2J&#27;[1;1HFAKE CLEAN REPORT</p>`);
  assert.ok(!text.includes(ESC), 'no escape byte may survive');
  assert.match(text, /Intro\[2J\[1;1HFAKE CLEAN REPORT/, 'the visible characters are kept');
});

test('page text reaches findings without control characters', async () => {
  const { runChecks } = await import('../src/core/checks.js');
  const html = `<!doctype html><html lang="en"><head><title>A page about widgets and things</title></head>
<body><main><h1>W</h1><p>Intro&#27;[2J&#27;[1;1H SCORE 100/100 ${'padding to push this opening past four hundred characters. '.repeat(10)}</p></main></body></html>`;

  const { findings } = runChecks({
    url: 'https://acme.com/w',
    page: {
      body: html, status: 200, ok: true, headers: { 'content-type': 'text/html; charset=utf-8' },
      elapsedMs: 5, bytes: html.length, redirects: [], truncated: false, finalUrl: 'https://acme.com/w',
    },
  });

  const dirty = findings.filter((f) =>
    [f.title, f.detail, f.evidence].some((v) => typeof v === 'string' && /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(v)),
  );
  assert.deepEqual(dirty.map((f) => f.id), [], 'no finding may carry a control character');
});

test('raw JSON-LD quoted as evidence is cleaned too', () => {
  // This path never passes through the entity decoder, so it needs its own
  // treatment rather than inheriting one.
  const blocks = jsonLdBlocks(`<script type="application/ld+json">{ broken ${ESC}[2J json</script>`);
  assert.equal(blocks[0].ok, false);
  assert.ok(!blocks[0].raw.includes(ESC));
  assert.match(blocks[0].raw, /broken \[2J json/);
});
