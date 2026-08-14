# Deploying Citable

Everything here runs on free tiers. The only thing you must not skip is generating
your own signing secret — the license system is worthless without one.

## 1. Deploy the Worker

The hosted app is a single Cloudflare Worker: no origin server, no database, no build
step. The Workers free tier covers 100,000 requests a day, which is far more audits
than you will need before the product is paying for itself.

```bash
npm install -g wrangler      # or use npx wrangler for everything below
wrangler login
```

Generate a signing secret and store it. Anyone with this value can mint free Pro keys,
so it never goes in the repo:

```bash
# 32 random bytes, base64
openssl rand -base64 32
wrangler secret put LICENSE_SECRET
# paste the value when prompted
```

Set your checkout link in `wrangler.toml` (`CHECKOUT_URL`), then:

```bash
wrangler deploy
```

You get a `https://citable.<your-subdomain>.workers.dev` URL immediately. A custom
domain is optional and free if the domain is already on Cloudflare.

Verify:

```bash
curl https://citable.<you>.workers.dev/api/health
{ "ok": true, "service": "citable", "crawlersTracked": 14,
  "licensingConfigured": true, "checkoutConfigured": true }

curl "https://citable.<you>.workers.dev/api/audit?url=example.com" | head -40
```

Check both configuration flags. Neither omission fails loudly on its own: without
a signing pair (`--keygen`) every Pro key is rejected and buyers quietly get the free tier, and
without a real `CHECKOUT_URL` there is nothing to buy. If checkout is unset, the site
renders "Checkout not configured" in place of the buy buttons rather than linking
visitors to a dead page — visible to you, and not a broken promise to them.

### Running it locally first

`wrangler dev` runs the Worker in `workerd`, the same runtime Cloudflare uses in
production, so it catches anything that works in Node but not on the edge:

```bash
printf 'LICENSE_SECRET=your-local-test-secret-32-chars\n' > .dev.vars   # gitignored
npx wrangler dev
```

Then check the routes: `/` (landing), `/demo` (a full sample report, no network call),
`/api/health`, `/robots.txt`, `/llms.txt`, and `/api/audit?url=example.com`.

This has been verified end to end in `workerd`: all routes serve, the SSRF guard
refuses private hosts, a valid key resolves to `tier: "pro"`, and a tampered key falls
back to free with a `bad_signature` warning rather than failing open.

### Optional: global rate limiting

The Worker rate-limits per isolate by default, which stops runaway scripts but is not a
global quota. To make it global, create a KV namespace and uncomment the binding in
`wrangler.toml`:

```bash
wrangler kv namespace create RATE
# paste the returned id into wrangler.toml, then redeploy
```

KV's free tier (100k reads, 1k writes per day) is enough for this use.

## 2. Publish the CLI

The CLI is the acquisition channel — it has to be free and genuinely useful, because
that is what earns the right to sell anything.

```bash
npm login
npm publish --access public
```

Check the package name is available first (`npm view citable`); if it is taken, rename
in `package.json` and update the README examples to match.

Test the published package before announcing it:

```bash
npx citable@latest example.com
```

## 3. Wire up payment

No payment integration is required to start. The flow is deliberately manual:

1. Buyer pays through a hosted checkout link (Gumroad, Lemon Squeezy, Polar or Stripe
   Payment Links — all free to set up, all take a percentage rather than a monthly fee).
2. You receive the sale notification.
3. You issue a key and email it:

```bash
node scripts/issue-key.mjs --keygen                       # once, before the first sale
node scripts/issue-key.mjs buyer@example.com              # lifetime key
node scripts/issue-key.mjs buyer@example.com --days 365   # annual key
```

The script prints the key plus ready-to-send instructions, and appends a record to
`licenses.ndjson` (gitignored — it contains customer emails).

### Do `--keygen` before you sell anything

`--keygen` creates an Ed25519 pair. The private half goes to `license.private.json`
(gitignored, mode 600) and signs keys; the public half is a line you paste into
`src/core/license.js` and commit, because it ships in the package and is what lets a
buyer's machine verify a key.

**Until you do this, `LICENSE_PUBLIC_KEY` is empty and every Pro key is refused with
`no_public_key_configured`.** Check `/api/health` — `portableKeysConfigured` must be
true, not just `licensingConfigured`.

Back the private half up somewhere you would keep a password. Losing it means
re-issuing every key ever sold under a new pair; leaking it means anyone can mint Pro
keys for free.

### Why not just the shared secret

`LICENSE_SECRET` signs the older `CTB1` keys with an HMAC, and HMAC is symmetric —
verifying a key requires the same secret that mints one. That works on the Worker,
which holds the secret and never shows it to anyone. It cannot work on a buyer's
machine: the published package ships no secret, so a `CTB1` key there is rejected and
the buyer silently gets the free tier despite having paid. Handing them the secret
would let them mint their own keys.

`CTB2` keys have no such problem, so issue those. `LICENSE_SECRET` remains only so
that keys sold before the change keep working in the hosted app.

Automate this only once the volume justifies it. A webhook that mints keys is one more
thing that can break at 3am, and manual issuance catches card fraud for free.

### Refunds and leaked keys

Keys are signed rather than stored, so revocation is a deny-list. It lives in
configuration rather than in code, so processing a refund does not mean editing source
and redeploying:

```bash
wrangler secret put REVOKED_KEYS
# paste a comma-separated list of key ids, e.g. k_tjm2nuhtauwh,k_9f2x1abc
```

The key id is printed when the key is issued and recorded in `licenses.ndjson`. The CLI
honours the same list via `CITABLE_REVOKED_KEYS`.

A revoked key does not error — it silently drops to the free tier, with the reason
reported in `licenseWarning`.

Annual keys expire on their own, which limits the blast radius of a leak you never
notice.

### When a buyer loses their key

Signing is deterministic, so the original key can be re-derived from the ledger rather
than issuing a second one:

```bash
node scripts/issue-key.mjs --find buyer@example.com
```

It prints the plan, seat count, expiry and the exact key that was sold. Prefer this over
issuing a replacement: two live keys for one purchase cannot later be revoked as a unit,
and a fresh `issue-key` run would silently extend the licence.

### Letting buyers check their own key

`GET /api/license?key=CTB2...` reports whether a key is valid, its plan, seat count and
expiry — without spending an audit. Point people at it before they email you:

```bash
curl "https://citable.<you>.workers.dev/api/license?key=CTB2..."
{ "valid": true, "reason": null, "plan": "pro", "seats": 1, "expiresAt": "2027-02-11T..." }
```

It never echoes the key or the buyer's email back, so it is safe to share the URL.

## 3b. Turn on GitHub Pages, or the shop window is invisible

The `Deploy site` workflow builds the static site and force-pushes it to a `gh-pages`
branch. It uses a branch push rather than the Pages deployment API because the default
workflow token cannot *create* a Pages site — it fails with "Resource not accessible by
integration".

**GitHub only serves that branch if Pages is switched on and pointed at it.** Until then
the workflow goes green, the branch updates on every push, and the public URL returns
404. Nothing anywhere reports a problem, because from the workflow's point of view
nothing went wrong — it was asked to push a branch and it pushed a branch.

Settings → Pages → Source: **Deploy from a branch** → `gh-pages` / `/ (root)`. Then:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<you>.github.io/<repo>/
# 200 means it is genuinely live; 404 means Pages is not pointed at gh-pages yet
```

Check it once, after the first deploy. It is the only step in this document whose
failure is completely silent, and the README links to that URL as though it works.

## 4. Verify the whole loop before announcing

```bash
# Issue yourself a key
node scripts/issue-key.mjs you@yourdomain.com

# It should unlock Pro locally
CITABLE_KEY="CTB2..." node bin/citable.js example.com --json | jq '.tier, .generated.robotsTxt'

# And on the hosted app
curl "https://citable.<you>.workers.dev/api/audit?url=example.com&key=CTB2..." | jq '.tier'

# The licence endpoint should agree
curl "https://citable.<you>.workers.dev/api/license?key=CTB2..." | jq '.valid'
```

If the hosted call returns `"free"` with a `licenseWarning`, the two secrets do not
match.

## 5. Dogfood it

The Worker serves its own `/robots.txt` and `/llms.txt`, both built from the same
crawler registry the auditor scores against. Audit your own deployment — a tool that
fails its own audit is not going to convince anybody:

```bash
node bin/citable.js https://citable.<you>.workers.dev
```
