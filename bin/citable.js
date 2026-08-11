#!/usr/bin/env node
/**
 * Citable CLI.
 *
 * The free tier here is deliberately useful on its own: a real score, the
 * crawler matrix, and the top findings. It is the top of the funnel, so it has
 * to stand up as a tool people keep using without ever paying.
 */

import process from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { auditSite, auditUrl, urlsFromSitemap } from '../src/core/audit.js';
import { renderHtml, renderMarkdown, renderSiteMarkdown, renderTerminal } from '../src/core/report.js';
import { tierFor } from '../src/core/license.js';

const VERSION = '0.1.0';

const HELP = `
citable ${VERSION} — audit whether AI answer engines can crawl, read and cite your site.

USAGE
  citable <url> [options]
  citable <url> --site [--limit 20]

OPTIONS
  --site              Audit multiple pages discovered from the sitemap.
  --limit <n>         Max pages in site mode (default 20).
  --key <key>         Pro license key. Also read from CITABLE_KEY.
  --json              Output raw JSON.
  --markdown          Output a Markdown report.
  --html              Output a self-contained HTML report (client deliverable;
                      prints and saves to PDF cleanly).
  --out <file>        Write the primary output to a file instead of stdout.
  --report <file>     Also write a report to this file, whatever the primary
                      output format is (one audit, two artifacts). The format
                      follows the extension: .html gives HTML, anything else
                      gives Markdown.

REPORT BRANDING (for HTML reports you hand to a client)
  --brand <name>      Replaces "Citable" in the report header.
  --accent <color>    Accent colour, any CSS colour (default #0d9488).
  --prepared-for <s>  Client name, shown under the page URL.
  --prepared-by <s>   Your name or agency, shown under the page URL.
  --min-score <n>     Exit non-zero if the score is below n (for CI).
  --fail-on <sev>     Exit non-zero on any finding at or above this severity
                      (critical|high|medium|low).
  --verbose           Include evidence in terminal output.
  --no-color          Disable ANSI colour.
  --timeout <ms>      Per-request timeout (default 15000).
  --allow-private     Permit localhost and private addresses, so you can audit
                      a dev server before you ship. CLI only.
  --version           Print version.
  --help              Show this help.

EXAMPLES
  citable example.com
  citable https://example.com/pricing --verbose
  citable example.com --site --limit 30 --markdown --out audit.md
  citable example.com --min-score 80          # fails the build below 80

  # A branded HTML report to hand a client
  citable client.com --html --out audit.html \\
    --brand "Acme Digital" --prepared-for "Client Co" --accent "#7c3aed"

PRO
  A Pro key unlocks every finding plus generated robots.txt, llms.txt, JSON-LD
  and FAQPage schema for each page. Set CITABLE_KEY or pass --key.
`;

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function parseArgs(argv) {
  const options = {
    url: null,
    site: false,
    limit: 20,
    key: process.env.CITABLE_KEY || null,
    json: false,
    markdown: false,
    html: false,
    out: null,
    report: null,
    brand: 'Citable',
    accent: '#0d9488',
    preparedFor: null,
    preparedBy: null,
    minScore: null,
    failOn: null,
    verbose: false,
    color: process.stdout.isTTY !== false && !process.env.NO_COLOR,
    timeout: 15000,
    // Safe here in a way it is not in the hosted worker: the CLI runs on the
    // developer's own machine, so pointing it at localhost is the intended
    // use rather than a request-forgery vector.
    allowPrivate: process.env.CITABLE_ALLOW_PRIVATE === '1',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--help':
      case '-h':
        return { help: true };
      case '--version':
      case '-v':
        return { version: true };
      case '--site':
        options.site = true;
        break;
      case '--limit':
        options.limit = Number.parseInt(next(), 10);
        break;
      case '--key':
        options.key = next();
        break;
      case '--json':
        options.json = true;
        break;
      case '--markdown':
      case '--md':
        options.markdown = true;
        break;
      case '--html':
        options.html = true;
        break;
      case '--brand':
        options.brand = next();
        break;
      case '--accent':
        options.accent = next();
        break;
      case '--prepared-for':
        options.preparedFor = next();
        break;
      case '--prepared-by':
        options.preparedBy = next();
        break;
      case '--out':
        options.out = next();
        break;
      case '--report':
        options.report = next();
        break;
      case '--min-score':
        options.minScore = Number.parseInt(next(), 10);
        break;
      case '--fail-on':
        options.failOn = String(next()).toLowerCase();
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--no-color':
        options.color = false;
        break;
      case '--allow-private':
        options.allowPrivate = true;
        break;
      case '--timeout':
        options.timeout = Number.parseInt(next(), 10);
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        if (!options.url) options.url = arg;
        break;
    }
  }

  return options;
}

/**
 * Resolve the tier. The signing secret lives on the seller's side, so the CLI
 * checks keys against the public verification secret shipped in the package
 * (or one supplied via env for self-hosted licensing).
 */
async function resolveTier(key) {
  const secret = process.env.CITABLE_LICENSE_SECRET || (await loadBundledSecret());
  if (!key) return { tier: 'free', license: null };
  const resolved = await tierFor(key, secret);
  if (resolved.tier !== 'pro') {
    const reason = resolved.license && resolved.license.reason;
    process.stderr.write(`citable: license key not accepted (${reason || 'invalid'}); continuing on the free tier.\n`);
  }
  return resolved;
}

async function loadBundledSecret() {
  try {
    const url = new URL('../license.public.json', import.meta.url);
    const raw = await readFile(url, 'utf8');
    return JSON.parse(raw).secret || null;
  } catch {
    return null;
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`citable: ${error.message}\n`);
    process.exit(2);
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!options.url) {
    process.stdout.write(HELP);
    process.exit(2);
  }

  const { tier } = await resolveTier(options.key);
  const fetchOptions = { timeoutMs: options.timeout, allowPrivate: options.allowPrivate };
  const audit = { tier, fetchOptions };

  let output;
  let markdown;
  let html = null;
  let worstScore;
  let findings = [];

  try {
    if (options.site) {
      const urls = await urlsFromSitemap(options.url, { limit: options.limit, fetchOptions });
      process.stderr.write(`citable: auditing ${urls.length} page(s)…\n`);
      const rollup = await auditSite(urls, {
        ...audit,
        onProgress: (page, done, total) => {
          const label = typeof page.score === 'number' ? `${page.score}/100` : 'failed';
          process.stderr.write(`  [${done}/${total}] ${label}  ${page.url}\n`);
        },
      });
      worstScore = rollup.averageScore;
      findings = rollup.pages.flatMap((page) => page.issues || []);
      markdown = renderSiteMarkdown(rollup, { brand: options.brand });
      // Site mode has no single-page HTML report; the rollup is Markdown.
      output = options.json ? JSON.stringify(rollup, null, 2) : markdown;
    } else {
      const result = await auditUrl(options.url, audit);
      worstScore = result.score;
      findings = result.issues;
      const branding = {
        brand: options.brand,
        accent: options.accent,
        preparedFor: options.preparedFor,
        preparedBy: options.preparedBy,
      };
      markdown = renderMarkdown(result, branding);
      html = renderHtml(result, branding);
      output = options.json
        ? JSON.stringify(result, null, 2)
        : options.html
          ? html
          : options.markdown
            ? markdown
            : renderTerminal(result, { color: options.color, verbose: options.verbose });
    }
  } catch (error) {
    process.stderr.write(`citable: ${(error && error.message) || error}\n`);
    process.exit(1);
  }

  if (options.out) {
    await writeFile(options.out, output, 'utf8');
    process.stderr.write(`citable: wrote ${options.out}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }

  // A second artifact from the same audit — no extra requests to the target.
  // The extension picks the format, so `--report audit.html` does what it looks
  // like it does.
  if (options.report && options.report !== options.out) {
    const wantsHtml = /\.html?$/i.test(options.report);
    if (wantsHtml && !html) {
      process.stderr.write('citable: HTML reports are per-page; use --report <file>.md in --site mode\n');
    } else {
      await writeFile(options.report, wantsHtml ? html : markdown, 'utf8');
      process.stderr.write(`citable: wrote ${options.report}\n`);
    }
  }

  // CI gates.
  if (options.minScore !== null && worstScore < options.minScore) {
    process.stderr.write(`citable: score ${worstScore} is below the required ${options.minScore}\n`);
    process.exit(1);
  }
  if (options.failOn) {
    const threshold = SEVERITY_RANK[options.failOn];
    if (threshold === undefined) {
      process.stderr.write(`citable: --fail-on must be one of critical|high|medium|low\n`);
      process.exit(2);
    }
    const triggered = findings.filter((issue) => SEVERITY_RANK[issue.severity] <= threshold);
    if (triggered.length) {
      process.stderr.write(`citable: ${triggered.length} finding(s) at or above "${options.failOn}"\n`);
      process.exit(1);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`citable: unexpected error: ${(error && error.stack) || error}\n`);
  process.exit(1);
});
