# How this makes money

An honest plan, with the parts that are uncertain marked as uncertain.

## The one-line thesis

Businesses are starting to notice they get traffic from AI assistants, and they have no
idea what governs it. The technical answer is boring and checkable: crawler access,
server-rendered content, structured data. That gap — high anxiety, low technical
mystery — is where a paid audit tool fits.

## What costs money to run

Nothing, until there is revenue.

| Thing | Provider | Cost |
| --- | --- | --- |
| Hosted app + API | Cloudflare Workers free tier | $0 (100k req/day) |
| Rate limiting state | Workers KV free tier, optional | $0 |
| CLI distribution | npm | $0 |
| Source hosting, CI, the Action | GitHub | $0 |
| License infrastructure | HMAC-signed keys, no database | $0 |
| Payment | Gumroad / Lemon Squeezy / Polar / Stripe link | % of sales only |
| Domain | optional; `*.workers.dev` works | $0–12/yr |

There is no fixed monthly cost to cover, which means there is no month where the
project is losing money. That is the main reason this shape was chosen over anything
needing a server or a database.

## The three revenue lines

### 1. Pro keys — $49 one-time (primary)

The free audit gives a real score, the full crawler matrix, and the top three findings.
Pro unlocks the rest plus the generators.

The generators are what people actually pay for. "You have no `llms.txt`" is
information. "Here is your `llms.txt`, built from your own page, paste it at
`/llms.txt`" is the job done. The gap between those two is the price.

Why one-time rather than subscription: a subscription needs a reason to renew, and a
site's AI visibility does not change weekly. One-time removes the churn conversation
entirely and converts better on a cold audience.

The one thing that would justify recurring pricing is regression monitoring, which now
exists (`--baseline` / `--fail-on-regression`). Its value is genuinely continuous: a
`robots.txt` edit that removes you from Perplexity throws no error and fails no test,
so the only way to catch it is to keep checking. If teams adopt the CI gate, that is
the signal to build a paid recurring tier around it — and the free tier deliberately
includes score and crawler-access regression alerts, because the alert has to be
trusted before anyone pays for a deeper version of it.

### 2. Done-for-you audits — $300–800

The HTML report is already a client deliverable — white-labelled with your own brand,
accent colour and a prepared-for line, self-contained in one file, and it prints or
saves to PDF cleanly:

```bash
# One page
citable client.com --html --out audit.html \
  --brand "Your Agency" --prepared-for "Client Co" --accent "#7c3aed"

# Or the whole site, which is what an engagement actually covers
citable client.com --site --limit 30 --html --out site-audit.html \
  --brand "Your Agency" --prepared-for "Client Co"
```

The site report leads with the issues that repeat across pages. That ordering
is most of the value you are selling: an issue on twenty pages is one change to
a shared template, not twenty pieces of work, and knowing which is which is
what the client cannot do themselves.

Agencies charge four figures for this work manually; the tool does the analysis in
seconds, and what you sell is the interpretation, prioritisation and the fixes
applied.

Realistically this is the highest revenue per hour early on, because you can do it
before anyone has heard of the product. Every engagement also generates the case-study
numbers ("score 41 → 88, cited by Perplexity within three weeks") that make the
self-serve tier credible.

### 3. Agency licence — $199/yr (later)

Multi-client use, white-labelled reports, unlimited site crawls. Only worth building
once at least a few agencies have asked, which they will if line 2 works. The license
system already carries `plan` and `seats` fields for this.

## Getting the first users

The CLI is the wedge. It costs nothing to try, gives a genuinely useful answer, and
leaves a number in the terminal that people screenshot.

**Things that plausibly work, roughly in order of effort:**

1. **Publish the npm package and the GitHub Action.** Both are discoverable surfaces
   that keep working without you.
2. **Run the audit on well-known sites and publish the results.** "I audited the top 100
   SaaS sites for AI visibility — 34 are blocking the crawlers that generate citations"
   is a post that writes itself from `--site --json`, and the finding is genuinely
   interesting. This is the single highest-leverage thing on this list.
3. **Answer the question where it is already being asked.** Threads about `llms.txt`,
   GPTBot, and "why doesn't ChatGPT know about my site" appear constantly. A specific,
   useful answer with a tool link at the end is welcome; a bare link is spam. Do the
   former.
4. **Free audits for people who ask publicly.** Run it, send the report, no pitch. Some
   fraction converts to line 2.
5. **The CI gate as a land-and-expand.** A team that adds the Action sees the score on
   every PR. That is where a per-seat conversation starts naturally.

## What is uncertain

Stating this plainly, because a plan that only lists upside is not a plan:

- **`llms.txt` adoption is not settled.** It may become standard or may fade. The audit
  weights it lightly (2 of 100 points) for exactly that reason — the product does not
  depend on it.
- **Crawler tokens change.** Vendors add and rename crawlers. `src/core/robots.js` is a
  single registry so this is a small edit, but it does need maintaining, and a stale
  registry is worse than none.
- **Scoring weights are a judgement call.** They are defensible and internally
  consistent, not empirically derived. Nobody has published the ground truth on what
  drives AI citations, and any tool claiming otherwise is guessing too. The scores are
  useful as a relative measure and a prioritised checklist — that is what they are sold
  as, and the README does not overclaim.
- **Demand timing.** The anxiety is real and growing, but budgets for "AEO" are new. The
  done-for-you line is the hedge: it works at any level of category maturity.

## What to do next, in order

0. **Merge this branch to `main`.** The code lives on a feature branch and the default
   branch holds only the README, so `github:sagarjha1846/inc` — the short install form
   people will try — resolves to a branch with no package in it. Every documented
   command currently has to name the branch explicitly. This is a one-minute change
   that removes friction from the first thing anyone does.
1. Deploy the Worker and publish the CLI (`docs/DEPLOY.md`). The static site is already
   live at sagarjha1846.github.io/inc and the CLI installs from the repository, so the
   product is reachable today; the Worker adds the hosted audit endpoint, and npm makes
   `npx citable` work.
2. Set up a checkout link and put its URL in `wrangler.toml`.
3. Run the audit across 100 well-known sites, write up what you find, publish it.
4. Offer free audits to the first ~20 people who engage with that post.
5. Convert the ones with real problems into done-for-you engagements.
6. Use those engagements to decide whether the recurring tier is worth building.

Step 3 is the one that determines whether any of this works. The tool is built; the
distribution is the remaining job.
