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
`LICENSE_SECRET` every Pro key is rejected and buyers quietly get the free tier, and
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
export CITABLE_LICENSE_SECRET="<the same secret you gave the Worker>"
node scripts/issue-key.mjs buyer@example.com          # lifetime key
node scripts/issue-key.mjs buyer@example.com --days 365   # annual key
```

The script prints the key plus ready-to-send instructions, and appends a record to
`licenses.ndjson` (gitignored — it contains customer emails).

**The Worker's `LICENSE_SECRET` and your local `CITABLE_LICENSE_SECRET` must match**,
or keys you issue will not validate.

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
export CITABLE_LICENSE_SECRET="..."
node scripts/issue-key.mjs --find buyer@example.com
```

It prints the plan, seat count, expiry and the exact key that was sold. Prefer this over
issuing a replacement: two live keys for one purchase cannot later be revoked as a unit,
and a fresh `issue-key` run would silently extend the licence.

### Letting buyers check their own key

`GET /api/license?key=CTB1...` reports whether a key is valid, its plan, seat count and
expiry — without spending an audit. Point people at it before they email you:

```bash
curl "https://citable.<you>.workers.dev/api/license?key=CTB1..."
{ "valid": true, "reason": null, "plan": "pro", "seats": 1, "expiresAt": "2027-02-11T..." }
```

It never echoes the key or the buyer's email back, so it is safe to share the URL.

## 4. Verify the whole loop before announcing

```bash
# Issue yourself a key
export CITABLE_LICENSE_SECRET="..."
node scripts/issue-key.mjs you@yourdomain.com

# It should unlock Pro locally
CITABLE_KEY="CTB1..." node bin/citable.js example.com --json | jq '.tier, .generated.robotsTxt'

# And on the hosted app
curl "https://citable.<you>.workers.dev/api/audit?url=example.com&key=CTB1..." | jq '.tier'

# The licence endpoint should agree
curl "https://citable.<you>.workers.dev/api/license?key=CTB1..." | jq '.valid'
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
