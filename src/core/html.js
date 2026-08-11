/**
 * Dependency-free, tolerant HTML inspection helpers.
 *
 * These are deliberately *not* a spec-compliant parser. An audit only needs to
 * see the document the way a non-JS-executing crawler sees it: which tags are
 * present in the raw bytes, what their attributes say, and how much readable
 * text survives once markup is removed. Regex-based extraction is enough for
 * that, runs identically on Node and Cloudflare Workers, and adds no install
 * weight to the CLI.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
};

/** Decode the HTML entities that realistically show up in page text. */
export function decodeEntities(input) {
  if (!input || input.indexOf('&') === -1) return input || '';
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Turn the inside of a start tag into a lowercase-keyed attribute map. */
export function parseAttributes(source) {
  const attrs = {};
  if (!source) return attrs;
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Find every occurrence of a tag, returning its attributes and — for non-void
 * elements — the raw inner HTML up to the matching close tag.
 */
export function findTags(html, tagName) {
  const out = [];
  if (!html) return out;
  const open = new RegExp(`<${tagName}(\\s[^>]*)?>`, 'gi');
  const close = new RegExp(`</${tagName}\\s*>`, 'i');
  let match;
  while ((match = open.exec(html)) !== null) {
    const attrs = parseAttributes(match[1] || '');
    const after = html.slice(match.index + match[0].length);
    const end = after.search(close);
    out.push({
      tag: tagName.toLowerCase(),
      attrs,
      inner: end === -1 ? '' : after.slice(0, end),
      index: match.index,
    });
    if (out.length > 5000) break; // pathological input guard
  }
  return out;
}

const REMOVABLE_BLOCKS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas'];

/** Remove elements whose content a reader never sees as prose. */
export function stripNonContent(html) {
  let out = html || '';
  for (const tag of REMOVABLE_BLOCKS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/>`, 'gi'), ' ');
  }
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  return out;
}

/**
 * The readable text a crawler extracts without running JavaScript.
 * Block-level tags become newlines so paragraph/heading structure survives.
 */
export function visibleText(html) {
  const stripped = stripNonContent(html)
    .replace(/<\/?(p|div|section|article|main|header|footer|aside|nav|li|tr|h[1-6]|br|hr|blockquote|pre|table|ul|ol|dl|dt|dd|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Rough word count of the server-rendered prose. */
export function wordCount(text) {
  if (!text) return 0;
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

/** All `<meta>` tags, keyed by lowercase name/property/http-equiv. */
export function metaTags(html) {
  const byName = new Map();
  for (const tag of findTags(html, 'meta')) {
    const key = (tag.attrs.name || tag.attrs.property || tag.attrs.itemprop || tag.attrs['http-equiv'] || '').toLowerCase();
    if (!key) continue;
    const value = tag.attrs.content ?? '';
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(value);
  }
  return byName;
}

/** First value for a meta key, or '' when absent. */
export function meta(html, key) {
  const tags = metaTags(html);
  const values = tags.get(key.toLowerCase());
  return values && values.length ? values[0].trim() : '';
}

/** Parsed JSON-LD blocks. Invalid JSON is reported rather than thrown away. */
export function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = re.exec(html || '')) !== null) {
    const attrs = parseAttributes(match[1] || '');
    const type = (attrs.type || '').toLowerCase();
    if (!type.includes('ld+json')) continue;
    const raw = match[2].trim();
    if (!raw) continue;
    try {
      blocks.push({ ok: true, data: JSON.parse(raw), raw });
    } catch (error) {
      blocks.push({ ok: false, error: String(error && error.message), raw });
    }
  }
  return blocks;
}

/** Flatten JSON-LD graphs/arrays into a single list of typed nodes. */
export function flattenJsonLd(blocks) {
  const nodes = [];
  const visit = (value, depth) => {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value['@graph'])) {
      for (const item of value['@graph']) visit(item, depth + 1);
    }
    if (value['@type']) nodes.push(value);
    for (const key of ['mainEntity', 'mainEntityOfPage', 'about', 'author', 'publisher', 'itemListElement']) {
      if (value[key] && typeof value[key] === 'object') visit(value[key], depth + 1);
    }
  };
  for (const block of blocks) if (block.ok) visit(block.data, 0);
  return nodes;
}

/** Lowercase set of every @type present anywhere in the JSON-LD. */
export function jsonLdTypes(nodes) {
  const types = new Set();
  for (const node of nodes) {
    const value = node['@type'];
    if (typeof value === 'string') types.add(value.toLowerCase());
    else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') types.add(item.toLowerCase());
  }
  return types;
}

/** Headings in document order with their depth and text. */
export function headings(html) {
  const out = [];
  const re = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi;
  let match;
  while ((match = re.exec(html || '')) !== null) {
    const text = visibleText(match[3]).replace(/\n+/g, ' ').trim();
    out.push({ level: Number(match[1]), text, attrs: parseAttributes(match[2] || '') });
    if (out.length > 1000) break;
  }
  return out;
}

/** Anchors with resolved absolute hrefs where possible. */
export function links(html, baseUrl) {
  const out = [];
  for (const tag of findTags(html, 'a')) {
    const href = (tag.attrs.href || '').trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    let absolute = null;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      absolute = null;
    }
    out.push({ href, absolute, rel: (tag.attrs.rel || '').toLowerCase(), text: visibleText(tag.inner).trim() });
    if (out.length > 3000) break;
  }
  return out;
}

/** `<title>` text. */
export function title(html) {
  const found = findTags(html, 'title')[0];
  return found ? visibleText(found.inner).replace(/\s+/g, ' ').trim() : '';
}

/** `<link rel=...>` hrefs for a given rel value. */
export function linkRel(html, rel) {
  const wanted = rel.toLowerCase();
  return findTags(html, 'link')
    .filter((tag) => (tag.attrs.rel || '').toLowerCase().split(/\s+/).includes(wanted))
    .map((tag) => tag.attrs.href)
    .filter(Boolean);
}

/** `lang` attribute on `<html>`. */
export function htmlLang(html) {
  const tag = findTags(html, 'html')[0];
  return tag ? (tag.attrs.lang || '').trim() : '';
}

/** Count of a tag's occurrences, used for structure signals. */
export function countTag(html, tagName) {
  const re = new RegExp(`<${tagName}\\b`, 'gi');
  const matches = (html || '').match(re);
  return matches ? matches.length : 0;
}
