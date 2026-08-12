# Citable

**Can ChatGPT, Claude, Perplexity and Google AI Overviews actually cite your site?**

Most sites fail without knowing. They block the crawlers that produce citations, ship
content that only exists after JavaScript runs, or give a model nothing structured to
attribute. Citable checks all three in about ten seconds and tells you exactly what to
change.

**[Live demo and sample reports →](https://sagarjha1846.github.io/inc/)**

```bash
# No npm publish needed — install straight from this repository
npx github:sagarjha1846/inc#claude/monetizable-project-ideas-o45uuc yoursite.com
```

```
https://yoursite.com/pricing
60/100 (D)  Not citable as it stands — 1 blocking issue prevents AI engines from using this page.

  Crawler access     █████████████████░░░░░░░ 20.6/30
  Readable content   ██████████████████████░░ 22.5/25
  Answer structure   ███████████████████░░░░░   12/15
  Structured data    ░░░░░░░░░░░░░░░░░░░░░░░░    0/15
  Metadata           ███████████░░░░░░░░░░░░░  4.5/10
  Authority signals  ░░░░░░░░░░░░░░░░░░░░░░░░    0/5

  Blocked crawlers: OAI-SearchBot, PerplexityBot

Findings (15 open)

  1. [CRITICAL] Invisible to ChatGPT Search and Perplexity — blocked by robots.txt
     These crawlers are the ones that fetch pages in order to answer live questions. While they
     are disallowed, this page cannot appear as a citation in the surfaces listed below, no
     matter how good the content is.
     → Add explicit Allow rules for these user-agents (see the generated robots.txt patch in this
     report).

  2. [HIGH] No JSON-LD structured data
     Structured data is how you state facts about the page in a form no model has to infer: who
     wrote it, what it is about, when it changed, what entity it belongs to. Without it,
     attribution depends entirely on the engine guessing correctly.
     → Add a JSON-LD block — the report generates one tailored to this page.

  3. [MEDIUM] No Organization or Person entity
     Nothing on the page tells an engine which organisation or person stands behind it, so
     citations are less likely to name you.
     → Add an Organization node with `name`, `url`, `logo` and `sameAs` links to your official
     profiles.

  12 more finding(s) + generated robots.txt / llms.txt / JSON-LD available with a Pro key.
```

---

## Why this is a real problem

Search is being replaced by answers. When someone asks an assistant a question, one of
two things decides whether your page is the source:

1. **Can the engine fetch it?** `robots.txt` is now a citation policy, not just a
   crawl budget setting. Blocking `PerplexityBot` or `OAI-SearchBot` removes you from
   those answers entirely — and most sites blocked them by copying a snippet from a
   blog post about "blocking AI scrapers", without realising they were two different
   decisions.
2. **Can the engine read it?** Most AI crawlers do not execute JavaScript. A React or
   Vue site that renders client-side serves them an empty `<div id="root">`. The page
   looks perfect in a browser and is blank to the crawler.

Both failures are silent. Nothing in your analytics tells you a citation didn't happen.

## What it checks

| Category | Weight | What it looks at |
| --- | --- | --- |
| Crawler access | 30 | Per-crawler `robots.txt` verdicts for 14 AI crawlers, `noindex`/`nosnippet`/`noarchive` directives in meta **and** `X-Robots-Tag`, HTTPS, `llms.txt`, sitemap |
| Readable content | 25 | Words surviving in raw HTML, JavaScript dependence, content depth, encoding, document size |
| Answer structure | 15 | Single H1, heading hierarchy, question-shaped headings, lists and tables, a quotable opening paragraph |
| Structured data | 15 | JSON-LD validity, publisher entity, page-type schema |
| Metadata | 10 | Title, description, canonical, `lang`, Open Graph |
| Authority signals | 5 | Authorship, freshness dates, outbound citations |

Every finding carries the evidence it was based on, which answer surfaces it costs you,
and the specific change that fixes it.

### Crawlers tracked

`GPTBot` · `OAI-SearchBot` · `ChatGPT-User` · `ClaudeBot` · `Claude-SearchBot` ·
`Claude-User` · `PerplexityBot` · `Perplexity-User` · `Google-Extended` ·
`Applebot-Extended` · `meta-externalagent` · `Amazonbot` · `CCBot` · `Bytespider`

Each is classified by purpose — **citation**, **live-fetch** or **training** — because
those are different decisions. Blocking training crawlers is a legitimate content
policy. Blocking citation crawlers is almost always an accident, and Citable scores
them differently for exactly that reason.

## Install

The package is not on npm yet, so install it straight from this repository.
The branch is spelled out because the code lives on a feature branch: the
default branch carries only this README, and the short `github:owner/repo`
form resolves there and fails. Merging to `main` is what makes the short form
work.

```bash
npm install -g github:sagarjha1846/inc#claude/monetizable-project-ideas-o45uuc
```

Or run it without installing:

```bash
npx github:sagarjha1846/inc#claude/monetizable-project-ideas-o45uuc yoursite.com
```

Once it is published to npm, `npm install -g citable` and `npx citable` will
work as well; every example below uses the bare `citable` command either way.

## Usage

```bash
# One page
citable example.com

# Show the evidence behind each finding
citable example.com --verbose

# Whole site, from the sitemap
citable example.com --site --limit 30

# A Markdown report you can hand to a client
citable example.com --site --markdown --out audit.md

# A white-labelled HTML report (prints and saves to PDF cleanly)
citable client.com --html --out audit.html \
  --brand "Acme Digital" --prepared-for "Client Co" --accent "#7c3aed"

# The same for a whole site — leads with the issues that repeat across pages,
# since those are one fix in a shared template rather than one fix per page
citable client.com --site --limit 30 --html --out site-audit.html \
  --brand "Acme Digital" --prepared-for "Client Co"

# Your dev server, before you ship
citable http://localhost:3000 --allow-private

# JSON for scripting
citable example.com --json | jq '.crawlers[] | select(.allowed == false)'
```

### In CI

Fail the build when a deploy would make you less citable:

```bash
citable https://yoursite.com --min-score 80 --fail-on critical
```

### Catching regressions

An absolute score tells you where you stand. What usually matters more is whether
today's change made things worse — particularly a `robots.txt` edit, which breaks
nothing, fails no test, and silently removes you from an answer engine:

```bash
# Record a baseline once
citable yoursite.com --json --out baseline.json

# On every deploy, compare against it
citable yoursite.com --baseline baseline.json --fail-on-regression
```

```
78/100 → 75/100 ▼ -3

Regression: this page is no longer reachable by ChatGPT Search, Perplexity.
A robots.txt change removed it from those answers.

Crawler access changes
  ✗ OAI-SearchBot (ChatGPT Search): allowed → blocked — Disallow: /
  ✗ PerplexityBot (Perplexity): allowed → blocked — Disallow: /
```

Or use the action:

```yaml
- uses: sagarjha1846/inc@main
  with:
    url: https://yoursite.com
    min-score: '80'
    baseline: baseline.json      # optional
    fail-on-regression: 'true'
    report: audit.html
```

### As a library

```js
import { auditUrl, renderMarkdown } from 'citable';

const result = await auditUrl('https://example.com', { tier: 'pro' });
console.log(result.score, result.grade);
console.log(result.generated.robotsTxt);  // ready to paste
```

Zero dependencies — nothing but `fetch` and WebCrypto, so the core imports no
platform modules at all.

Verified on Node 22, Bun 1.3 and Deno 2.9, which produce identical scores and
findings, and under `workerd` via `wrangler dev`. Re-check any runtime yourself:

```bash
node scripts/check-runtime.mjs
bun  scripts/check-runtime.mjs
deno run -A scripts/check-runtime.mjs
```

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| Score and category breakdown | ✅ | ✅ |
| Full AI crawler access matrix | ✅ | ✅ |
| Findings shown | Top 3 | All |
| Generated `robots.txt` patch | — | ✅ |
| Generated `llms.txt` | — | ✅ |
| Generated JSON-LD and FAQPage schema | — | ✅ |
| Whole-site crawl and Markdown reports | — | ✅ |
| White-labelled HTML client reports (page and whole-site) | — | ✅ |
| CI gating and score/crawler regression alerts | ✅ | ✅ |
| Finding-level regression diff | — | ✅ |

The generators are the point of Pro: they emit the actual files, filled in with what
was found on your page, so the fix is a paste rather than a project.

```bash
export CITABLE_KEY="CTB2..."
citable yoursite.com --site --markdown --out audit.md
```

## Where it runs

| Surface | URL | What works |
| --- | --- | --- |
| Static site | [sagarjha1846.github.io/inc](https://sagarjha1846.github.io/inc/) | Landing page, interactive demo report, both sample deliverables |
| CLI | `citable yoursite.com` (see Install) | Everything, no rate limit |
| Hosted app | your own Cloudflare Worker | Everything, including the live web UI |

The static site cannot run live audits: auditing a URL needs a server-side fetch, which
a static host cannot do and a browser is blocked from doing by CORS. It is the shop
window; the CLI and the Worker are the shop.

## Self-hosting

The hosted app is one Cloudflare Worker with no database and no origin server, so it
runs inside the free tier:

```bash
npx wrangler login
npx wrangler secret put LICENSE_SECRET   # 32+ random characters
npx wrangler deploy
```

See [docs/DEPLOY.md](docs/DEPLOY.md) for the full walkthrough, and
[docs/MONETIZATION.md](docs/MONETIZATION.md) for how the paid tier is wired up.

## Development

Enable the pre-push hook once per clone, so a red suite cannot reach the
branch (hooks are not versioned, so cloning does not install it):

```bash
git config core.hooksPath .githooks
```

```bash
node --test                    # 304 tests, no install step
node bin/citable.js --help
npx wrangler dev               # hosted UI at localhost:8787, /demo for a sample report
```

The test suite covers robots.txt semantics, scoring, tier enforcement, license
signing, the worker routes, the study generator's published statistics, and a
real-HTTP integration suite that exercises redirects, size caps and timeouts against a
live loopback server.

The Worker has also been verified running under `workerd` — every route, the SSRF
guard, and license verification resolving `pro` for a valid key and falling back to
free for a tampered one.

### Generating a study

The audit runs over a list of sites and writes up the aggregate, which is the most
effective way to get the tool in front of people who need it:

```bash
node scripts/benchmark.mjs --list scripts/domains.example.txt --out study
# writes study.md (the writeup) and study.json (the data behind every claim)
```

## License

MIT — see [LICENSE](LICENSE).
