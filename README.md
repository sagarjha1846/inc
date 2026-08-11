# Citable

**Can ChatGPT, Claude, Perplexity and Google AI Overviews actually cite your site?**

Most sites fail without knowing. They block the crawlers that produce citations, ship
content that only exists after JavaScript runs, or give a model nothing structured to
attribute. Citable checks all three in about ten seconds and tells you exactly what to
change.

```bash
npx citable yoursite.com
```

```
https://yoursite.com/
62/100 (D)  Weak. AI engines can reach this page but have little reason to quote it.

  Crawler access     ███████████████░░░░░░░░░   19/30
  Readable content   ████████████████████████   25/25
  Answer structure   ███████░░░░░░░░░░░░░░░░░    5/15
  Structured data    ░░░░░░░░░░░░░░░░░░░░░░░░    0/15
  Metadata           ████████████████████░░░░    8/10
  Authority signals  ██████████░░░░░░░░░░░░░░    2/5

  Blocked crawlers: PerplexityBot, OAI-SearchBot

Findings (11 open)

  1. [CRITICAL] 2 answer-engine crawler(s) blocked by robots.txt
     These crawlers are the ones that fetch pages in order to answer live questions.
     While they are disallowed, this page cannot appear as a citation in the surfaces
     listed below, no matter how good the content is.
     → Add explicit Allow rules for these user-agents.
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
| Authority | 5 | Authorship, freshness dates, outbound citations |

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

## Usage

```bash
# One page
npx citable example.com

# Show the evidence behind each finding
npx citable example.com --verbose

# Whole site, from the sitemap
npx citable example.com --site --limit 30

# A Markdown report you can hand to a client
npx citable example.com --site --markdown --out audit.md

# A white-labelled HTML report (prints and saves to PDF cleanly)
npx citable client.com --html --out audit.html \
  --brand "Acme Digital" --prepared-for "Client Co" --accent "#7c3aed"

# Your dev server, before you ship
npx citable http://localhost:3000 --allow-private

# JSON for scripting
npx citable example.com --json | jq '.crawlers[] | select(.allowed == false)'
```

### In CI

Fail the build when a deploy would make you less citable:

```bash
npx citable https://yoursite.com --min-score 80 --fail-on critical
```

### Catching regressions

An absolute score tells you where you stand. What usually matters more is whether
today's change made things worse — particularly a `robots.txt` edit, which breaks
nothing, fails no test, and silently removes you from an answer engine:

```bash
# Record a baseline once
npx citable yoursite.com --json --out baseline.json

# On every deploy, compare against it
npx citable yoursite.com --baseline baseline.json --fail-on-regression
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

Zero dependencies. Runs on Node 20+, Cloudflare Workers, Deno and Bun — nothing but
`fetch` and WebCrypto.

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
| White-labelled HTML client reports | — | ✅ |
| CI gating and score/crawler regression alerts | ✅ | ✅ |
| Finding-level regression diff | — | ✅ |

The generators are the point of Pro: they emit the actual files, filled in with what
was found on your page, so the fix is a paste rather than a project.

```bash
export CITABLE_KEY="CTB1..."
npx citable yoursite.com --site --markdown --out audit.md
```

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

```bash
node --test "test/*.test.js"   # 78 tests, no install step
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
