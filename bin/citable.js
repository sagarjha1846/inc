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
import { renderHtml, renderMarkdown, renderSiteHtml, renderSiteMarkdown, renderTerminal } from '../src/core/report.js';
import { compareAudits, renderComparison, renderComparisonMarkdown } from '../src/core/compare.js';
import { tierFor } from '../src/core/license.js';
import { isSafeAccent } from '../src/core/report.js';

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
                      prints and saves to PDF cleanly). Works for a single page
                      and, with --site, for a whole-site rollup.
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
  --baseline <file>   Compare against an earlier --json result and report what
                      changed: score movement, new and fixed findings, and any
                      crawler that went from allowed to blocked.
  --fail-on-regression  Exit non-zero if the comparison shows a regression.
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

  # Catch regressions between deploys
  citable example.com --json --out baseline.json
  citable example.com --baseline baseline.json --fail-on-regression

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
    baseline: null,
    failOnRegression: false,
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

    /**
     * A number, or a usage error — never NaN and never a silent
     * reinterpretation.
     *
     * `Number.parseInt` kept whatever it produced, which made a typo change
     * behaviour instead of stopping it. `--min-score abc` became NaN, and
     * `score < NaN` is false, so the CI gate quietly passed every build: a
     * team using `--min-score ${VARS_THRESHOLD}` with the variable unset lost
     * their regression protection and saw nothing but green. `--limit 1e9`
     * parsed as 1 and audited a single page while looking like it worked.
     */
    const nextNumber = ({ min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
      const raw = next();
      // `Number('')` is 0, and a `--min-score 0` gate never fails — so an unset
      // CI variable expanding to nothing would disable the check while looking
      // like a deliberate threshold. That is the case this exists to catch, so
      // it cannot be the one that slips through.
      if (String(raw).trim() === '') throw new Error(`${arg} needs a whole number, got an empty value`);
      const value = Number(raw);
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(`${arg} needs a whole number, got "${raw}"`);
      }
      if (value < min || value > max) {
        throw new Error(`${arg} must be between ${min} and ${max}, got ${value}`);
      }
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
        options.limit = nextNumber({ min: 1, max: 5000 });
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
      case '--accent': {
        // Validated here as well as in the renderer, so a typo is a usage error
        // rather than a silent fall back to the default colour — the report
        // would otherwise come out unbranded with nothing saying why.
        const value = next();
        if (!isSafeAccent(value)) throw new Error(`--accent needs a CSS colour, got "${value}"`);
        options.accent = value;
        break;
      }
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
      case '--baseline':
        options.baseline = next();
        break;
      case '--fail-on-regression':
        options.failOnRegression = true;
        break;
      case '--min-score':
        options.minScore = nextNumber({ min: 0, max: 100 });
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
        options.timeout = nextNumber({ min: 1, max: 600_000 });
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
  // No bundled secret, deliberately. CTB2 keys verify against the public key
  // compiled into src/core/license.js and need nothing here; CTB1 keys need
  // the signing secret, which only the seller and the Worker ever have. The
  // previous fallback read a "secret" out of a bundled file — shipping that
  // would have handed every buyer the ability to mint their own keys.
  const secret = process.env.CITABLE_LICENSE_SECRET;
  if (!key) return { tier: 'free', license: null };
  const resolved = await tierFor(key, secret, { revoked: process.env.CITABLE_REVOKED_KEYS });
  if (resolved.tier !== 'pro') {
    const reason = resolved.license && resolved.license.reason;
    process.stderr.write(`citable: license key not accepted (${reason || 'invalid'}); continuing on the free tier.\n`);
  }
  return resolved;
}

/**
 * Write an artifact, or say plainly why it could not be written.
 *
 * The audit has already run and succeeded by this point, so the failure is
 * always about the path: a directory that does not exist, a name that is a
 * directory, a read-only location. Those surfaced as
 * "citable: unexpected error: Error: ENOENT: no such file or directory" —
 * a Node internal, on a documented flag, for the most foreseeable typo there
 * is, and labelled "unexpected" by the program that should have expected it.
 *
 * Exits 1 rather than 2: the invocation was valid, the filesystem refused.
 */
async function write(target, contents) {
  try {
    await writeFile(target, contents, 'utf8');
    process.stderr.write(`citable: wrote ${target}\n`);
  } catch (error) {
    const reason = {
      ENOENT: 'the directory does not exist',
      EISDIR: 'that path is a directory',
      EACCES: 'permission denied',
      EPERM: 'permission denied',
      ENOSPC: 'no space left on the device',
      EROFS: 'the filesystem is read-only',
    }[error && error.code] || (error && error.message) || 'unknown error';
    process.stderr.write(`citable: could not write ${target} — ${reason}\n`);
    process.exit(1);
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
  let diff = null;
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
      const siteBranding = {
        brand: options.brand,
        accent: options.accent,
        preparedFor: options.preparedFor,
        preparedBy: options.preparedBy,
      };
      markdown = renderSiteMarkdown(rollup, siteBranding);
      html = renderSiteHtml(rollup, siteBranding);
      output = options.json
        ? JSON.stringify(rollup, null, 2)
        : options.html
          ? html
          : markdown;
    } else {
      const result = await auditUrl(options.url, audit);
      worstScore = result.score;
      findings = result.issues;

      // Baseline mode replaces the normal single-page output: what the caller
      // asked for is the delta, not another snapshot.
      if (options.baseline) {
        let previous;
        try {
          previous = JSON.parse(await readFile(options.baseline, 'utf8'));
        } catch (error) {
          process.stderr.write(`citable: could not read baseline ${options.baseline}: ${error.message}\n`);
          process.exit(2);
        }
        diff = compareAudits(previous, result);
        markdown = renderComparisonMarkdown(diff);
        output = options.json
          ? JSON.stringify(diff, null, 2)
          : options.markdown
            ? markdown
            : renderComparison(diff, { color: options.color });
      } else {
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
    }
  } catch (error) {
    process.stderr.write(`citable: ${(error && error.message) || error}\n`);
    process.exit(1);
  }

  if (options.out) {
    await write(options.out, output);
  } else {
    process.stdout.write(`${output}\n`);
  }

  // A second artifact from the same audit — no extra requests to the target.
  // The extension picks the format, so `--report audit.html` does what it looks
  // like it does.
  if (options.report && options.report !== options.out) {
    const wantsHtml = /\.html?$/i.test(options.report);
    await write(options.report, wantsHtml ? html : markdown);
  }

  // CI gates.
  if (options.failOnRegression) {
    if (!diff) {
      process.stderr.write('citable: --fail-on-regression needs --baseline <file>\n');
      process.exit(2);
    }
    if (diff.regressed) {
      process.stderr.write(`citable: ${diff.summary}\n`);
      process.exit(1);
    }
  }
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
