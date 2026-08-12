#!/usr/bin/env node
/**
 * Regenerate src/worker/sample.js — the report shown at /demo.
 *
 * The sample is produced by running the real auditor against a fixture built
 * to have realistic, illustrative flaws, so the demo is genuine output rather
 * than hand-written marketing numbers. Re-run this whenever the checks or the
 * result shape change, or the demo will drift out of sync with the product.
 *
 *   node scripts/build-sample.mjs
 */

import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { auditUrl } from '../src/core/audit.js';

// A plausible mid-market SaaS page: decent content, but blocking the crawlers
// that produce citations, no structured data, and no llms.txt. That mix is
// what the audit exists to surface, and it is the most common real profile.
const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Northwind Analytics — Pricing</title>
  <meta name="description" content="Simple usage-based pricing for Northwind Analytics. Start free, pay only for the events you track.">
  <meta property="og:title" content="Northwind Analytics — Pricing">
</head>
<body>
  <h1>Pricing</h1>
  <p>Northwind Analytics is priced per tracked event, with no seat charges and no annual commitment. Every plan includes the full feature set; the only thing that changes is volume.</p>
  <h2>Plans</h2>
  <table>
    <tr><th>Plan</th><th>Events</th><th>Price</th></tr>
    <tr><td>Free</td><td>10k/mo</td><td>$0</td></tr>
    <tr><td>Team</td><td>1M/mo</td><td>$99</td></tr>
    <tr><td>Scale</td><td>10M/mo</td><td>$499</td></tr>
  </table>
  <h2>What counts as an event?</h2>
  <p>${'An event is any single tracked user action, recorded once at the moment it happens. '.repeat(14)}</p>
  <h2>Do unused events roll over?</h2>
  <p>${'Unused volume does not roll over between billing periods, and overage is billed at the same per-event rate as the plan. '.repeat(12)}</p>
  <h2>Can I change plans mid-month?</h2>
  <p>${'You can move between plans at any time and the change is prorated to the day. '.repeat(12)}</p>
</body>
</html>`;

const ROBOTS = `# Block AI scrapers
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: PerplexityBot
Disallow: /

User-agent: OAI-SearchBot
Disallow: /

User-agent: *
Allow: /

Sitemap: https://northwind.example/sitemap.xml
`;

const server = http.createServer((req, res) => {
  if (req.url === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(ROBOTS);
  }
  if (req.url === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml' });
    return res.end('<urlset><url><loc>https://northwind.example/pricing</loc></url></urlset>');
  }
  if (req.url === '/llms.txt') {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const result = await auditUrl(`http://127.0.0.1:${port}/pricing`, {
  tier: 'pro',
  fetchOptions: { allowPrivate: true },
});
server.close();

// Present it under a plausible public URL rather than the loopback fixture.
// Rewriting the serialised form catches every occurrence — the fixture host
// also appears inside finding evidence, generated files and nested schema, and
// a single missed one would leak "127.0.0.1" onto the public demo page.
const sanitized = JSON.parse(
  JSON.stringify(result)
    .split(`http://127.0.0.1:${port}`)
    .join('https://northwind.example')
    .split(`127.0.0.1:${port}`)
    .join('northwind.example')
    // The generators derive a site name from the bare hostname, so it also
    // appears without the port.
    .split('127.0.0.1')
    .join('northwind.example'),
);

// Anything measured rather than derived has to be pinned, or the committed
// sample differs on every rebuild and a drift check cannot tell a real change
// from the clock and the calendar moving. Two things vary: the generated
// JSON-LD falls back to today's date when a page declares none, and the
// response time is quoted inside a finding's own text as well as in the http
// block.
const PINNED_DATE = '2026-01-01';
const PINNED_MS = 214;
for (const block of ['jsonLd', 'faqSchema']) {
  const generated = sanitized.generated?.[block];
  if (!generated) continue;
  for (const field of ['json', 'markup']) {
    if (typeof generated[field] === 'string') {
      generated[field] = generated[field].replace(/"(datePublished|dateModified)": "\d{4}-\d{2}-\d{2}"/g, `"$1": "${PINNED_DATE}"`);
    }
  }
}

for (const finding of [...(sanitized.issues || []), ...(sanitized.passes || [])]) {
  if (typeof finding.detail === 'string') {
    finding.detail = finding.detail.replace(/Served in \d+ms/, `Served in ${PINNED_MS}ms`);
  }
}

sanitized.url = 'https://northwind.example/pricing';
sanitized.requestedUrl = sanitized.url;
sanitized.fetchedAt = '2026-01-01T00:00:00.000Z';
sanitized.elapsedMs = 842;
sanitized.http.responseMs = PINNED_MS;

const remaining = JSON.stringify(sanitized).match(/127\.0\.0\.1|localhost/g);
if (remaining) {
  process.stderr.write(`build-sample: fixture host leaked into the sample (${remaining.length} occurrence(s))\n`);
  process.exit(1);
}

const banner = `/**
 * A sample audit result, shown at /demo.
 *
 * Generated by scripts/build-sample.mjs from a fixture page — this is real
 * auditor output, not hand-written copy. Regenerate it whenever the checks or
 * the result shape change.
 */

`;

await writeFile(
  new URL('../src/worker/sample.js', import.meta.url),
  `${banner}export const SAMPLE_RESULT = ${JSON.stringify(sanitized, null, 2)};\n`,
  'utf8',
);

process.stderr.write(`build-sample: wrote src/worker/sample.js (score ${sanitized.score}, ${sanitized.issuesTotal} findings)\n`);
