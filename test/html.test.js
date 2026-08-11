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
