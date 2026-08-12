#!/usr/bin/env node
/**
 * Build the static site published to GitHub Pages.
 *
 * Pages serves files, not code, so the live audit endpoint cannot run there —
 * auditing a URL needs a server-side fetch, and a browser is blocked by CORS
 * from fetching arbitrary sites. What this deploys is the part that works
 * without a server: the landing page, a complete sample report, and the
 * install instructions. It is a shop window, not the shop.
 *
 * The single-page and whole-site HTML reports are also emitted, since those
 * are the paid artifacts and seeing one is most of the sales argument.
 *
 *   node scripts/build-site.mjs [outDir]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { renderApp } from '../src/worker/ui.js';
import { SAMPLE_RESULT } from '../src/worker/sample.js';
import { renderHtml, renderSiteHtml } from '../src/core/report.js';
import { AI_CRAWLERS } from '../src/core/robots.js';

const outDir = process.argv[2] || 'site';
const REPO = 'https://github.com/sagarjha1846/inc';

// Sitemap entries have to be absolute — the protocol has no notion of a
// relative location — so the published origin is named here rather than
// derived. Everything else on the page stays relative and works from any host.
const SITE = 'https://sagarjha1846.github.io/inc';

/**
 * Where the buy buttons point.
 *
 * `CITABLE_CHECKOUT_URL` is read from the environment so that wiring up a real
 * payment link is a repository variable rather than a code change.
 *
 * Until one exists there is nothing that can take money, and the two remaining
 * options are a button that fails and a way to reach the seller. This build
 * used to pass the README's feature table as `priceUrl`, which satisfied the
 * "not a placeholder" test and rendered a live "Get a Pro key" button leading
 * to a comparison chart — the exact broken promise that guard was written to
 * prevent, defeated by pointing it at a real URL that happens not to sell
 * anything.
 *
 * A pre-filled issue on the repository is the honest stand-in: it costs
 * nothing, needs no payment processor and no published email address, and it
 * captures the one thing that actually matters before checkout exists, which
 * is that someone wanted to buy.
 */
const CHECKOUT_URL = process.env.CITABLE_CHECKOUT_URL || '';
const REQUEST_URL = `${REPO}/issues/new?title=${
  encodeURIComponent('Pro key request')
}&body=${
  encodeURIComponent(
    'I would like a Citable Pro key ($49, one-time).\n\n'
      + 'Site to audit:\n'
      + 'Email to send the key to:\n\n'
      + 'Checkout is not wired up yet, so keys are issued by hand — reply here and\n'
      + 'you will get one back.\n',
  )
}`;

/** The pages worth listing, in the order a reader would want them. */
const PAGES = [
  { path: '/', priority: '1.0' },
  { path: '/demo.html', priority: '0.9' },
  { path: '/sample-report.html', priority: '0.7' },
  { path: '/sample-site-report.html', priority: '0.7' },
];

/**
 * The hosted app's audit form posts to /api/audit, which does not exist on a
 * static host. Rather than leave a button that fails, the form is replaced
 * with the honest alternative: run it locally, where there is no rate limit
 * and no CORS problem.
 */
function staticiseLanding(html) {
  const replacement = `
  <div class="card" style="border-color:var(--accent)">
    <h3>Run an audit</h3>
    <p class="fix" style="font-size:15px;margin-bottom:14px">
      Live audits need a server-side fetch — a browser cannot request another site directly.
      This page is the demo; the auditor itself runs from your terminal, with no rate limit:
    </p>
    <pre style="font-size:14px"><code>npx github:sagarjha1846/inc#claude/monetizable-project-ideas-o45uuc yoursite.com</code></pre>
    <p class="fix" style="margin-top:14px">
      Or <a href="./demo.html">see a complete sample report</a> first, and
      <a href="${REPO}#self-hosting">deploy the hosted version</a> to a free Cloudflare Worker
      if you want the web UI on your own domain.
    </p>
  </div>`;

  // Swap the interactive form and Pro-key row for the instructions above.
  // The region is delimited by comment markers in the template rather than by
  // hunting for the form and the end of a section: those two moved apart when
  // the headline was relocated into <main>, and an index pair that no longer
  // brackets the same region splices out the wrong span without erroring.
  const start = html.indexOf('  <!--run-->');
  const end = html.indexOf('<!--/run-->');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('landing page run-form markers missing or reordered; update staticiseLanding()');
  }
  let out = html.slice(0, start) + replacement + '\n  ' + html.slice(end + '<!--/run-->'.length);

  // The footer documents the JSON API, which does not exist on a static host
  // either. Leaving it advertises an endpoint that answers 404 here.
  const apiLine = /  <p>API: <code>[^<]*<\/code>[\s\S]*?<\/p>\n/;
  if (!apiLine.test(out)) throw new Error('footer API line not found; update staticiseLanding()');
  out = out.replace(
    apiLine,
    `  <p>CLI: <code>npx github:sagarjha1846/inc#claude/monetizable-project-ideas-o45uuc example.com</code> · ` +
      `the JSON API ships with the <a href="${REPO}#self-hosting">self-hosted Worker</a>.</p>\n`,
  );
  return out;
}

await mkdir(outDir, { recursive: true });

// 1. Landing page, with the non-functional audit form replaced.
const landing = staticiseLanding(renderApp({ priceUrl: CHECKOUT_URL, requestUrl: REQUEST_URL }));
await writeFile(`${outDir}/index.html`, landing, 'utf8');

// 2. The interactive demo, exactly as the hosted app serves it.
await writeFile(
  `${outDir}/demo.html`,
  renderApp({ priceUrl: CHECKOUT_URL, requestUrl: REQUEST_URL, demoResult: SAMPLE_RESULT }),
  'utf8',
);

// 3. The two paid deliverables, so the value is visible rather than described.
await writeFile(`${outDir}/sample-report.html`, renderHtml(SAMPLE_RESULT, { brand: 'Citable' }), 'utf8');

const siteRollup = {
  pagesAudited: 1,
  pagesFailed: 0,
  averageScore: SAMPLE_RESULT.score,
  worst: SAMPLE_RESULT,
  best: SAMPLE_RESULT,
  sitewideIssues: SAMPLE_RESULT.issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    severity: issue.severity,
    pages: 1,
    fix: issue.fix,
  })),
  pages: [SAMPLE_RESULT],
};
await writeFile(`${outDir}/sample-site-report.html`, renderSiteHtml(siteRollup, { brand: 'Citable' }), 'utf8');

// 4. Practise what the tool preaches: the deployed site allows the crawlers it
//    tells everyone else to allow, and publishes its own llms.txt.
const citation = AI_CRAWLERS.filter((crawler) => crawler.purpose !== 'training');
await writeFile(
  `${outDir}/robots.txt`,
  `# Citable — we practise what we audit.\n\n${citation
    .map((crawler) => `User-agent: ${crawler.token}\nAllow: /\n`)
    .join('\n')}\nUser-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`,
  'utf8',
);

// The audit tells every visitor to publish a sitemap and point robots.txt at
// it. Ours flagged the same gap on our own landing page, which is the one site
// where the advice is checkable before anyone buys.
const lastmod = new Date().toISOString().slice(0, 10);
await writeFile(
  `${outDir}/sitemap.xml`,
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES
    .map(({ path, priority }) => `  <url>\n    <loc>${SITE}${path}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <priority>${priority}</priority>\n  </url>\n`)
    .join('')}</urlset>\n`,
  'utf8',
);

await writeFile(
  `${outDir}/llms.txt`,
  `# Citable

> Citable audits whether AI answer engines — ChatGPT, Claude, Perplexity and Google AI Overviews — can crawl, read and cite a web page, and generates the exact files needed to fix what it finds.

## Core pages

- [Home](./index.html): What Citable checks and why it matters.
- [Live demo report](./demo.html): A complete Pro-tier audit of an example page.
- [Sample client report](./sample-report.html): The single-page deliverable.
- [Sample site report](./sample-site-report.html): The whole-site deliverable.
- [Source and install](${REPO}): \`npx github:sagarjha1846/inc#claude/monetizable-project-ideas-o45uuc yoursite.com\`

## What it checks

- Crawler access: whether robots.txt permits the crawlers that produce citations.
- Readable content: whether the answer text exists in HTML without JavaScript.
- Answer structure: whether a model can lift a clean answer from the page.
- Structured data: whether the page states its facts machine-readably.
- Metadata and authority: title, description, canonical, authorship and freshness.
`,
  'utf8',
);

// GitHub Pages runs Jekyll by default, which would ignore files it does not
// recognise and mangle others.
await writeFile(`${outDir}/.nojekyll`, '', 'utf8');

process.stderr.write(`build-site: wrote ${outDir}/ (index, demo, 2 sample reports, robots.txt, sitemap.xml, llms.txt)\n`);
