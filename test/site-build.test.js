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
