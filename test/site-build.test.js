/**
 * The static site build.
 *
 * scripts/build-site.mjs performs string surgery on the landing page to strip
 * the audit form, because that form posts to an endpoint a static host does
 * not have. It throws if the markup it looks for has moved — which means an
 * ordinary edit to the UI breaks the *deploy*, not the test suite, and the
 * first sign of it is a red workflow after the change has already landed.
 *
 * These tests run the real build and check the output, so that failure surfaces
 * where it can be fixed cheaply.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Run the real build script into a temp directory. */
async function build(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'citable-site-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/build-site.mjs', dir], { cwd: ROOT, stdio: 'ignore' });
    child.on('close', resolve);
  });
  assert.equal(code, 0, 'build-site.mjs should exit cleanly');
  return dir;
}

test('the build produces every file the deploy expects', async (t) => {
  const dir = await build(t);
  const files = await readdir(dir);
  for (const name of [
    'index.html',
    'demo.html',
    'sample-report.html',
    'sample-site-report.html',
    'robots.txt',
    'sitemap.xml',
    'llms.txt',
    '.nojekyll',
  ]) {
    assert.ok(files.includes(name), `missing ${name}`);
  }
});

test('the landing page has no audit form, and says what to run instead', async (t) => {
  const dir = await build(t);
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');

  // The form posts to /api/audit, which does not exist on a static host.
  // Leaving it would give every visitor a button that fails.
  assert.doesNotMatch(html, /<form/i, 'the static build must not ship the audit form');

  // The footer documented the JSON API, which 404s on a static host. Only the
  // unreachable fetch inside the guarded submit handler may still name it.
  const visible = html.split('<script>')[0];
  assert.doesNotMatch(visible, /\/api\/audit/, 'no visible text may advertise the missing endpoint');

  // And the alternative that does work has to be present.
  assert.match(html, /npx github:sagarjha1846\/inc/);
  assert.match(html, /Live audits need a server-side fetch/);
});

test('the landing page script survives having no form', async (t) => {
  const dir = await build(t);
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  const script = html.split('<script>').pop().split('</script>')[0];

  // A missing guard here throws on load and takes the rest of the page's
  // behaviour with it.
  assert.match(script, /if \(form\)/, 'the submit handler must be guarded');
  assert.doesNotThrow(() => new Function(script), 'the inline script must parse');
});

test('the demo page still carries a complete paid report', async (t) => {
  const dir = await build(t);
  const html = await readFile(path.join(dir, 'demo.html'), 'utf8');

  const injected = html.split('window.__CITABLE_DEMO__ = ')[1].split(';</script>')[0];
  const demo = JSON.parse(injected);
  assert.equal(demo.tier, 'pro', 'the demo sells the paid tier');
  assert.ok(demo.issuesTotal > 0);
  assert.deepEqual(Object.keys(demo.generated).sort(), ['faqSchema', 'jsonLd', 'llmsTxt', 'robotsTxt']);
});

test('nothing published references a placeholder or a build fixture', async (t) => {
  const dir = await build(t);
  // Both would be visible to every visitor: a dead buy link, or an internal
  // host in what is meant to be a real sample.
  for (const name of await readdir(dir)) {
    const body = await readFile(path.join(dir, name), 'utf8');
    assert.doesNotMatch(body, /127\.0\.0\.1|localhost/, `${name} leaks a build fixture host`);
  }

  // CHANGE-ME is legitimate *inside a generated report* — the JSON-LD the tool
  // emits deliberately marks the fields a user must fill in, and says so. It is
  // only a defect on the landing page, where it would mean a dead buy link.
  const landing = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.doesNotMatch(landing, /CHANGE-ME/, 'the landing page must not ship a placeholder link');
});

test('the site is self-contained, so it works offline and cannot leak referrers', async (t) => {
  const dir = await build(t);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.html'))) {
    const body = await readFile(path.join(dir, name), 'utf8');
    assert.doesNotMatch(body, /<script[^>]+src=/i, `${name} loads an external script`);
    assert.doesNotMatch(body, /<link[^>]+href=["']https?:/i, `${name} loads an external stylesheet`);
    assert.doesNotMatch(body, /@import/i, `${name} imports external CSS`);
  }
});

test('the published site passes the policy it sells', async (t) => {
  const dir = await build(t);

  const robots = await readFile(path.join(dir, 'robots.txt'), 'utf8');
  // A tool that told everyone to allow these crawlers while blocking them
  // itself would not survive its own audit.
  for (const token of ['OAI-SearchBot', 'PerplexityBot', 'Claude-SearchBot', 'ChatGPT-User']) {
    assert.match(robots, new RegExp(`User-agent: ${token}\\nAllow: /`), `${token} should be allowed`);
  }
  assert.doesNotMatch(robots, /Disallow: \//);

  const llms = await readFile(path.join(dir, 'llms.txt'), 'utf8');
  assert.match(llms, /^# Citable/);
  assert.match(llms, /^> /m, 'llms.txt needs a summary blockquote');
  assert.ok((llms.match(/^- \[/gm) || []).length >= 3, 'llms.txt needs curated links');
});

test('the sitemap exists, is absolute, and robots.txt points at it', async (t) => {
  // Both halves are the fix the audit prescribes for `sitemap`, so shipping one
  // without the other would leave our own landing page failing our own check.
  const dir = await build(t);
  const sitemap = await readFile(path.join(dir, 'sitemap.xml'), 'utf8');

  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);

  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length >= 4, 'every published page belongs in the sitemap');
  for (const loc of locs) {
    // A relative <loc> is invalid per the protocol and is silently dropped.
    assert.doesNotThrow(() => new URL(loc), `relative loc: ${loc}`);
    assert.match(loc, /^https:\/\//, `${loc} should be absolute and secure`);
  }

  const robots = await readFile(path.join(dir, 'robots.txt'), 'utf8');
  const declared = robots.match(/^Sitemap:\s*(\S+)$/m);
  assert.ok(declared, 'robots.txt must declare the sitemap');
  assert.ok(locs.some((loc) => loc.startsWith(new URL(declared[1]).origin)), 'the declared sitemap must share the site origin');
});

test('every page the sitemap lists is actually published', async (t) => {
  // A sitemap advertising a 404 is worse than none: it spends crawl budget and
  // signals a site that does not know its own shape.
  const dir = await build(t);
  const sitemap = await readFile(path.join(dir, 'sitemap.xml'), 'utf8');
  const files = new Set(await readdir(dir));

  for (const loc of [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])) {
    const name = new URL(loc).pathname.split('/').pop() || 'index.html';
    assert.ok(files.has(name), `sitemap lists ${name}, which the build does not produce`);
  }
});

test('no button offers to sell what the page cannot sell', async (t) => {
  // The guard in renderApp only tests that the URL is not a known placeholder,
  // which cannot tell a checkout from any other link. The static build passed
  // the README's feature comparison table as `priceUrl`, so every visitor who
  // clicked "Get a Pro key" landed on a chart — the exact broken promise the
  // guard exists to prevent, and every test still passed.
  //
  // The invariant is about the promise, not the URL: a button may say "get" or
  // "unlock" only when it leads somewhere that takes money.
  const dir = await build(t);

  for (const name of ['index.html', 'demo.html']) {
    const html = await readFile(path.join(dir, name), 'utf8');
    const buttons = [...html.matchAll(/<a class="cta[^"]*" href="([^"]+)">([^<]+)<\/a>/g)];
    assert.ok(buttons.length > 0, `${name} should offer some way to buy`);

    for (const [, href, label] of buttons) {
      if (/get a pro key|unlock the full report/i.test(label)) {
        assert.fail(`${name}: "${label}" promises a purchase but points at ${href}`);
      }
      // Whatever it does say, it must be reachable and honest about it.
      assert.doesNotThrow(() => new URL(href), `${name}: ${label} → unparseable ${href}`);
      assert.match(label, /request/i, `${name}: "${label}" should say it is a request, not a sale`);
    }
  }
});

test('the request path carries what is needed to fulfil a sale', async (t) => {
  // A captured intent is only worth anything if it arrives with the site to
  // audit and somewhere to send the key.
  const dir = await build(t);
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  const href = html.match(/<a class="cta cta-request" href="([^"]+)"/)[1];
  const body = decodeURIComponent(new URL(href.replace(/&amp;/g, '&')).searchParams.get('body') || '');

  assert.match(body, /Site to audit/);
  assert.match(body, /Email to send the key to/);
  assert.match(body, /\$49/);
});

test('a real checkout URL takes precedence over the request path', async (t) => {
  // Wiring up payment must be a repository variable, not a code change, or it
  // will not happen on the day it matters.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'citable-site-checkout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/build-site.mjs', dir], {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, CITABLE_CHECKOUT_URL: 'https://checkout.example/buy' },
    });
    child.on('close', resolve);
  });
  assert.equal(code, 0);

  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /href="https:\/\/checkout\.example\/buy"/);
  assert.match(html, /Get a Pro key/, 'with a real checkout the button sells again');
  // The `.cta-request` CSS rule is always in the stylesheet; what must be absent
  // is an anchor carrying it.
  assert.doesNotMatch(html, /<a class="cta cta-request"/);
});

test('the FAQ schema says exactly what the page says', async (t) => {
  // Structured data whose answers do not match the visible page is worse than
  // none: it is the machine-readable half drifting from the human half, which
  // is the failure this product exists to find. Both are generated from one
  // constant, so this asserts the property that arrangement is for — and would
  // catch anyone re-hardcoding either side.
  const dir = await build(t);
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');

  const block = html.split('application/ld+json">')[1].split('</script>')[0];
  const graph = JSON.parse(block)['@graph'];
  const faq = graph.find((node) => node['@type'] === 'FAQPage');
  assert.ok(faq, 'the landing page should carry FAQPage schema');
  assert.ok(faq.mainEntity.length >= 5, 'and enough questions to be worth having');

  // Visible text, with markup and entities resolved the way a reader sees it.
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

  for (const entry of faq.mainEntity) {
    assert.equal(entry['@type'], 'Question');
    assert.equal(entry.acceptedAnswer['@type'], 'Answer');
    assert.ok(visible.includes(entry.name), `question not on the page: ${entry.name}`);
    // Compare a distinctive span rather than the whole answer, so ordinary
    // whitespace differences do not fail a test about meaning.
    const opening = entry.acceptedAnswer.text.slice(0, 60);
    assert.ok(visible.includes(opening), `answer not on the page: ${opening}…`);
  }

  // And the authorship the audit asks every site for.
  const app = graph.find((node) => node['@type'] === 'SoftwareApplication');
  assert.ok(app.author, 'the page should name who stands behind it');
});

test('the landing page passes its own content-depth check', async (t) => {
  // The audit graded this page "317 words — this page gives a model little to
  // work with". Selling depth from a thin page is the kind of thing a prospect
  // checks.
  const dir = await build(t);
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  const { runChecks } = await import('../src/core/checks.js');

  const { findings } = runChecks({
    url: 'https://sagarjha1846.github.io/inc/',
    page: {
      body: html, status: 200, ok: true, headers: { 'content-type': 'text/html; charset=utf-8' },
      elapsedMs: 5, bytes: html.length, redirects: [], truncated: false,
      finalUrl: 'https://sagarjha1846.github.io/inc/',
    },
  });

  const depth = findings.find((finding) => finding.id === 'content-depth');
  assert.equal(depth.severity, 'pass', `our own landing page is thin: ${depth.title}`);

  const questions = findings.find((finding) => finding.id === 'question-headings');
  assert.equal(questions.severity, 'pass', 'the page should answer questions people actually ask');
});
