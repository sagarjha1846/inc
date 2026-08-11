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
    <pre style="font-size:14px"><code>npx github:sagarjha1846/inc yoursite.com</code></pre>
    <p class="fix" style="margin-top:14px">
      Or <a href="./demo.html">see a complete sample report</a> first, and
      <a href="${REPO}#self-hosting">deploy the hosted version</a> to a free Cloudflare Worker
      if you want the web UI on your own domain.
    </p>
  </div>`;

  // Swap the interactive form and Pro-key row for the instructions above.
  const start = html.indexOf('  <form id="f">');
  const end = html.indexOf('</header>');
  if (start === -1 || end === -1) throw new Error('landing page structure changed; update staticiseLanding()');
  return html.slice(0, start) + replacement + '\n' + html.slice(end);
}

await mkdir(outDir, { recursive: true });

// 1. Landing page, with the non-functional audit form replaced.
const landing = staticiseLanding(renderApp({ priceUrl: `${REPO}#free-vs-pro` }));
await writeFile(`${outDir}/index.html`, landing, 'utf8');

// 2. The interactive demo, exactly as the hosted app serves it.
await writeFile(`${outDir}/demo.html`, renderApp({ priceUrl: `${REPO}#free-vs-pro`, demoResult: SAMPLE_RESULT }), 'utf8');

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
    .join('\n')}\nUser-agent: *\nAllow: /\n`,
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
- [Source and install](${REPO}): \`npx github:sagarjha1846/inc yoursite.com\`

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

process.stderr.write(`build-site: wrote ${outDir}/ (index, demo, 2 sample reports, robots.txt, llms.txt)\n`);
