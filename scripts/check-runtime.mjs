#!/usr/bin/env node
/**
 * Check the published core under whichever runtime executes this file.
 *
 * The README claims the core runs on Node, Cloudflare Workers, Deno and Bun.
 * Node and Workers are covered by the test suite and by `wrangler dev`; the
 * other two were an inference from "it only uses web standards" until this
 * script was run against them. An inference is not a verified claim — the
 * install instructions in this repository were wrong for exactly that reason,
 * having been extrapolated from a command that was never tried.
 *
 * Run it under each runtime you want to claim support for:
 *
 *   node    scripts/check-runtime.mjs
 *   bun     scripts/check-runtime.mjs
 *   deno run -A scripts/check-runtime.mjs
 *
 * Every runtime should print the same score and finding count. No network is
 * used: fetch is stubbed, so the only thing being exercised is the core.
 */

import { auditUrl, renderHtml, renderMarkdown, renderTerminal } from '../src/core/index.js';
import { issueKey, verifyKey } from '../src/core/license.js';
import { crawlerMatrix } from '../src/core/robots.js';
import { decodeEntities, visibleText } from '../src/core/html.js';

const runtime =
  typeof Bun !== 'undefined'
    ? `Bun ${Bun.version}`
    : typeof Deno !== 'undefined'
      ? `Deno ${Deno.version.deno}`
      : `Node ${globalThis.process.version}`;

let failures = 0;
const fail = (message) => {
  console.log(`  FAIL  ${message}`);
  failures += 1;
};

// 1. Parsing, with no platform APIs involved beyond the language itself.
if (visibleText('<p>Hello</p><script>x</script>') !== 'Hello') fail('visibleText');
if (decodeEntities('a&#27;b') !== 'ab') fail('control-character stripping');
const matrix = crawlerMatrix('User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n', '/');
if (matrix.find((crawler) => crawler.token === 'PerplexityBot').allowed !== false) fail('robots matcher');

// 2. WebCrypto. This is the revenue path, and the most likely thing to differ
//    between runtimes, so a wrong secret must be rejected as well as a right
//    one accepted.
const secret = 'x'.repeat(32);
const { key } = await issueKey({ email: 'a@b.co', secret, days: 30 });
if (!(await verifyKey(key, secret)).valid) fail('a valid licence key was rejected');
if ((await verifyKey(key, 'y'.repeat(32))).valid) fail('a key verified against the wrong secret');

// 3. A full audit over a stubbed fetch, then every renderer.
const PAGE = `<!doctype html><html lang="en"><head><title>What is a widget?</title>
<meta name="description" content="A practical explanation of widgets and how to choose between the common types available.">
</head><body><main><h1>What is a widget?</h1><p>${'A widget couples two shafts together. '.repeat(30)}</p>
<h2>How do I fit one?</h2><p>${'Align the shafts and tighten the collar evenly. '.repeat(30)}</p></main></body></html>`;

const fetchImpl = async (url) => {
  const target = String(url);
  if (target.endsWith('/robots.txt')) {
    return new Response('User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n', {
      headers: { 'content-type': 'text/plain' },
    });
  }
  if (target.endsWith('/llms.txt') || target.endsWith('/sitemap.xml')) return new Response('', { status: 404 });
  return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
};

const result = await auditUrl('https://acme.test/w', { tier: 'pro', fetchOptions: { fetchImpl } });
if (!result.crawlers.some((crawler) => crawler.token === 'PerplexityBot' && !crawler.allowed)) {
  fail('the blocked crawler was not detected');
}
if (!result.generated.robotsTxt.includes('PerplexityBot')) fail('generators');
for (const [label, output] of [
  ['markdown', renderMarkdown(result)],
  ['html', renderHtml(result)],
  ['terminal', renderTerminal(result, { color: false })],
]) {
  if (!output || output.length < 200) fail(`${label} renderer produced nothing`);
}

console.log(
  `  ${runtime.padEnd(18)} score ${result.score}/${result.grade}  ${result.issuesTotal} findings  ` +
    `${failures ? `${failures} FAILURE(S)` : 'all checks pass'}`,
);

if (failures) {
  if (typeof Deno !== 'undefined') Deno.exit(1);
  else globalThis.process.exit(1);
}
