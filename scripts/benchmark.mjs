#!/usr/bin/env node
/**
 * Audit many sites at once and write up the aggregate as a publishable study.
 *
 * This is the marketing engine, not a developer utility. "34% of the top SaaS
 * sites block the crawlers that generate AI citations" is a finding people
 * share, and it is derived from the same checks the product sells. Running it
 * also stress-tests the auditor against real-world HTML, which is where
 * tolerant parsers usually break.
 *
 *   node scripts/benchmark.mjs --list domains.txt --out study
 *   node scripts/benchmark.mjs --list domains.txt --concurrency 4
 *
 * Writes <out>.md (the study) and <out>.json (the raw data behind it, so any
 * claim in the writeup can be checked).
 */

import process from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { auditUrl } from '../src/core/audit.js';
import { AI_CRAWLERS } from '../src/core/robots.js';
import { CATEGORIES } from '../src/core/checks.js';

function usage(message) {
  if (message) process.stderr.write(`benchmark: ${message}\n\n`);
  process.stderr.write(`Usage:
  benchmark --list <file> [--out study] [--concurrency 3] [--timeout 15000]

  --list         File with one domain or URL per line. Blank lines and lines
                 starting with # are ignored.
  --out          Output basename (default "study"). Writes .md and .json.
  --concurrency  Parallel audits (default 3). Keep this low — these are other
                 people's servers.
  --timeout      Per-request timeout in ms (default 15000).
  --allow-private  Permit localhost/private hosts. For testing the script
                 against local fixtures, not for real studies.
`);
  process.exit(message ? 2 : 0);
}

const flag = (argv, name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const percent = (count, total) => (total === 0 ? 0 : Math.round((count / total) * 100));

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help')) usage();

  const listPath = flag(argv, 'list');
  if (!listPath) usage('--list is required');
  const outBase = flag(argv, 'out', 'study');
  const concurrency = Math.max(1, Math.min(8, Number.parseInt(flag(argv, 'concurrency', '3'), 10) || 3));
  const timeoutMs = Number.parseInt(flag(argv, 'timeout', '15000'), 10) || 15000;
  const allowPrivate = argv.includes('--allow-private');

  const targets = (await readFile(listPath, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (!targets.length) usage(`${listPath} contained no domains`);
  process.stderr.write(`benchmark: auditing ${targets.length} site(s), ${concurrency} at a time\n`);

  const results = [];
  let done = 0;

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map(async (target) => {
        try {
          // Pro tier so every finding is counted, not just the free top three.
          const result = await auditUrl(target, { tier: 'pro', includeGenerators: false, fetchOptions: { timeoutMs, allowPrivate } });
          return { target, ok: true, result };
        } catch (error) {
          return { target, ok: false, error: (error && error.message) || 'failed', code: (error && error.code) || 'error' };
        }
      }),
    );
    for (const item of settled) {
      results.push(item);
      done += 1;
      const label = item.ok ? `${item.result.score}/100` : `failed (${item.code})`;
      process.stderr.write(`  [${done}/${targets.length}] ${String(label).padEnd(16)} ${item.target}\n`);
    }
  }

  const good = results.filter((item) => item.ok).map((item) => item.result);
  if (!good.length) {
    process.stderr.write('benchmark: every audit failed — check network access before publishing anything.\n');
    process.exit(1);
  }

  const study = buildStudy(good, results.length);
  await writeFile(`${outBase}.md`, study, 'utf8');
  await writeFile(
    `${outBase}.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sitesAttempted: results.length,
        sitesAudited: good.length,
        results: results.map((item) =>
          item.ok
            ? {
                url: item.result.url,
                score: item.result.score,
                grade: item.result.grade,
                words: item.result.stats.words,
                issues: item.result.issuesTotal,
                blockedCrawlers: item.result.crawlers.filter((crawler) => !crawler.allowed).map((crawler) => crawler.token),
                findings: item.result.issues.map((issue) => ({ id: issue.id, severity: issue.severity })),
                categories: Object.fromEntries(Object.values(item.result.categories).map((category) => [category.key, category.earned])),
              }
            : { url: item.target, error: item.error, code: item.code },
        ),
      },
      null,
      2,
    ),
    'utf8',
  );

  process.stderr.write(`\nbenchmark: wrote ${outBase}.md and ${outBase}.json\n`);
}

function buildStudy(results, attempted) {
  const total = results.length;
  const scores = results.map((result) => result.score).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)];
  const mean = Math.round(scores.reduce((sum, score) => sum + score, 0) / total);

  // Per-crawler block rates. Only counts sites that actually published a
  // robots.txt — a site with no robots.txt blocks nothing, and folding those
  // in as "allowed" would understate the real block rate among sites that
  // made a deliberate choice.
  const withRobots = results.filter((result) => result.crawlers && result.crawlers.length);
  const blockRates = AI_CRAWLERS.map((crawler) => {
    const blocked = withRobots.filter((result) =>
      result.crawlers.some((entry) => entry.token === crawler.token && !entry.allowed),
    ).length;
    return { ...crawler, blocked, rate: percent(blocked, withRobots.length) };
  }).sort((a, b) => b.rate - a.rate);

  // How often each finding fires.
  const frequency = new Map();
  for (const result of results) {
    for (const issue of result.issues) {
      const entry = frequency.get(issue.id) || { id: issue.id, title: issue.title, severity: issue.severity, count: 0 };
      entry.count += 1;
      frequency.set(issue.id, entry);
    }
  }
  const common = [...frequency.values()].sort((a, b) => b.count - a.count);

  const jsOnly = results.filter((result) => result.issues.some((issue) => issue.id === 'js-rendered' && issue.severity === 'critical'));
  const noSchema = results.filter((result) => result.issues.some((issue) => issue.id === 'jsonld-present'));
  const noLlms = results.filter((result) => result.issues.some((issue) => issue.id === 'llms-txt' && issue.severity !== 'pass'));
  const blockingCitation = withRobots.filter((result) =>
    result.crawlers.some((crawler) => !crawler.allowed && (crawler.purpose === 'citation' || crawler.purpose === 'live-fetch')),
  );

  const grades = ['A', 'B', 'C', 'D', 'F'].map((grade) => ({
    grade,
    count: results.filter((result) => result.grade === grade).length,
  }));

  const lines = [];
  lines.push(`# How ready is the web for AI answer engines?`);
  lines.push('');
  lines.push(`We audited ${total} site${total === 1 ? '' : 's'} for one question: can ChatGPT, Claude, Perplexity and Google AI Overviews crawl, read and cite them?`);
  lines.push('');
  lines.push(`**The short answer: the median site scores ${median}/100.**`);
  lines.push('');
  lines.push('## Headline numbers');
  lines.push('');
  lines.push('| Finding | Share of sites |');
  lines.push('| --- | --- |');
  lines.push(`| Block at least one crawler that produces AI citations | **${percent(blockingCitation.length, withRobots.length)}%** (${blockingCitation.length} of ${withRobots.length} with a robots.txt) |`);
  lines.push(`| Serve content only after JavaScript runs — invisible to most AI crawlers | **${percent(jsOnly.length, total)}%** (${jsOnly.length}) |`);
  lines.push(`| Publish no valid JSON-LD structured data | **${percent(noSchema.length, total)}%** (${noSchema.length}) |`);
  lines.push(`| Have no usable llms.txt | **${percent(noLlms.length, total)}%** (${noLlms.length}) |`);
  lines.push('');
  lines.push(`Mean score ${mean}/100, median ${median}/100, range ${scores[0]}–${scores[scores.length - 1]}.`);
  if (attempted > total) {
    lines.push('');
    lines.push(`${attempted - total} site${attempted - total === 1 ? '' : 's'} could not be fetched at all and are excluded.`);
  }
  lines.push('');

  lines.push('## Grade distribution');
  lines.push('');
  lines.push('| Grade | Sites | |');
  lines.push('| --- | --- | --- |');
  for (const { grade, count } of grades) {
    lines.push(`| ${grade} | ${count} | ${'█'.repeat(Math.round((count / total) * 40))} |`);
  }
  lines.push('');

  lines.push('## Which AI crawlers get blocked');
  lines.push('');
  lines.push('Purpose matters here. Blocking a **training** crawler is a defensible content policy. Blocking a **citation** or **live-fetch** crawler removes the site from AI answers, which is almost never what anyone intended.');
  lines.push('');
  lines.push('| Crawler | Vendor | Purpose | Blocked by |');
  lines.push('| --- | --- | --- | --- |');
  for (const crawler of blockRates) {
    lines.push(`| \`${crawler.token}\` | ${crawler.vendor} | ${crawler.purpose} | ${crawler.rate}% |`);
  }
  lines.push('');

  lines.push('## The most common problems');
  lines.push('');
  lines.push('| Issue | Sites affected |');
  lines.push('| --- | --- |');
  for (const issue of common.slice(0, 15)) {
    lines.push(`| ${issue.title.replace(/^\d+ /, '')} | ${percent(issue.count, total)}% |`);
  }
  lines.push('');

  lines.push('## Where sites lose points');
  lines.push('');
  lines.push('| Category | Average | Out of |');
  lines.push('| --- | --- | --- |');
  for (const key of Object.keys(CATEGORIES)) {
    const average = results.reduce((sum, result) => sum + result.categories[key].earned, 0) / total;
    lines.push(`| ${CATEGORIES[key].label} | ${Math.round(average * 10) / 10} | ${CATEGORIES[key].weight} |`);
  }
  lines.push('');

  lines.push('## Every site audited');
  lines.push('');
  lines.push('| Site | Score | Grade | Blocked citation crawlers |');
  lines.push('| --- | --- | --- | --- |');
  for (const result of [...results].sort((a, b) => b.score - a.score)) {
    const blocked = result.crawlers
      .filter((crawler) => !crawler.allowed && crawler.purpose !== 'training')
      .map((crawler) => crawler.token);
    lines.push(`| ${result.url} | ${result.score} | ${result.grade} | ${blocked.join(', ') || '—'} |`);
  }
  lines.push('');

  lines.push('## Method');
  lines.push('');
  lines.push('Each site was fetched once as a plain HTTP client with no JavaScript execution — the same view most AI crawlers get. We then read its `robots.txt`, `llms.txt` and `sitemap.xml`, and scored six categories: crawler access (30), readable content (25), answer structure (15), structured data (15), metadata (10) and authority signals (5).');
  lines.push('');
  lines.push('Scoring weights are a judgement call, not an empirically derived model — no vendor publishes what actually drives citations. The individual measurements underneath are objective and reproducible: the raw JSON alongside this report contains every finding for every site, so any number here can be checked.');
  lines.push('');
  lines.push('Audited with [Citable](https://github.com/sagarjha1846/inc) — `npx citable yoursite.com`.');
  lines.push('');
  return lines.join('\n');
}

main().catch((error) => {
  process.stderr.write(`benchmark: ${(error && error.stack) || error}\n`);
  process.exit(1);
});
