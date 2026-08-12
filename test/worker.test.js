import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/worker/index.js';
import { renderApp } from '../src/worker/ui.js';
import { issueKey } from '../src/core/license.js';

const SECRET = 'worker-test-secret';

const PAGE = `<!doctype html><html lang="en"><head><title>A page about widgets and how they work</title>
<meta name="description" content="Everything you need to know about widgets, how they are made, and how to choose between them in practice.">
</head><body><h1>Widgets</h1><p>${'Widgets are small components that do a specific job well. '.repeat(30)}</p></body></html>`;

/** Swap globalThis.fetch for the duration of one test. */
async function withStubbedFetch(routes, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const route = routes[url] ?? routes[String(url).replace(/\/$/, '')];
    if (!route) return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(route.body ?? '', {
      status: route.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...(route.headers || {}) },
    });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const env = { LICENSE_SECRET: SECRET, CHECKOUT_URL: 'https://checkout.example/buy' };

test('GET / serves the app shell with the pricing and audit form', async () => {
  const response = await worker.fetch(new Request('https://citable.test/'), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /Run free audit/);
  assert.match(html, /https:\/\/checkout\.example\/buy/);
});

test('the rendered page leaves no un-interpolated placeholders in static markup', () => {
  const html = renderApp({ priceUrl: 'https://buy.test' });
  // Placeholders inside <script> are browser-side template literals and are
  // interpolated at runtime; one left in the *markup* would render as literal
  // text on the page, which is the regression worth guarding.
  const markupOnly = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  const leaked = [...markupOnly.matchAll(/\$\{[a-zA-Z_][\w.]*\}/g)].map((match) => match[0]);
  assert.deepEqual(leaked, [], `un-interpolated placeholders in markup: ${leaked.join(', ')}`);
  assert.match(html, /<title>Citable/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /Citable checks \d+ AI crawlers/);
});

test('/demo serves a full sample report with no network call', async () => {
  const response = await worker.fetch(new Request('https://citable.test/demo'), env);
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /window\.__CITABLE_DEMO__/);
  // The demo must show the paid output, since that is what it is selling.
  assert.match(html, /robotsTxt/);
  assert.match(html, /northwind\.example/);
  // A fixture host leaking into the public demo would be embarrassing.
  assert.doesNotMatch(html, /127\.0\.0\.1/);
  // `</script>` inside the injected JSON would break out of the script block.
  const injected = html.split('window.__CITABLE_DEMO__ = ')[1].split(';</script>')[0];
  assert.doesNotMatch(injected, /<\/script/i);
  assert.equal(typeof JSON.parse(injected).score, 'number');
});

test('the auditor’s own robots.txt allows every citation crawler', async () => {
  const response = await worker.fetch(new Request('https://citable.test/robots.txt'), env);
  const body = await response.text();
  assert.match(body, /User-agent: PerplexityBot\nAllow: \//);
  assert.match(body, /User-agent: OAI-SearchBot\nAllow: \//);
  assert.match(body, /Sitemap: https:\/\/citable\.test\/sitemap\.xml/);
});

test('the auditor publishes its own llms.txt', async () => {
  const response = await worker.fetch(new Request('https://citable.test/llms.txt'), env);
  const body = await response.text();
  assert.match(body, /^# Citable/);
  assert.match(body, /^> /m);
  assert.ok((body.match(/^- \[/gm) || []).length >= 3);
});

test('POST /api/audit returns a free-tier result', async () => {
  await withStubbedFetch({ 'https://widgets.test/': { body: PAGE } }, async () => {
    const response = await worker.fetch(
      new Request('https://citable.test/api/audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://widgets.test/' }),
      }),
      env,
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.tier, 'free');
    assert.ok(data.score > 0);
    assert.ok(data.issues.length <= 3);
    assert.equal(data.generated, undefined);
  });
});

test('a valid Pro key unlocks the full result over the API', async () => {
  const { key } = await issueKey({ email: 'buyer@test.co', secret: SECRET, days: 30 });
  await withStubbedFetch({ 'https://widgets.test/': { body: PAGE } }, async () => {
    const response = await worker.fetch(
      new Request('https://citable.test/api/audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ url: 'https://widgets.test/' }),
      }),
      env,
    );
    const data = await response.json();
    assert.equal(data.tier, 'pro');
    assert.equal(data.issuesWithheld, 0);
    assert.ok(data.generated.llmsTxt.length > 50);
  });
});

test('an invalid key degrades to free with a warning rather than erroring', async () => {
  await withStubbedFetch({ 'https://widgets.test/': { body: PAGE } }, async () => {
    const response = await worker.fetch(
      new Request('https://citable.test/api/audit?url=https://widgets.test/&key=CTB1.bogus.sig'),
      env,
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.tier, 'free');
    assert.match(data.licenseWarning, /not accepted/);
  });
});

test('format=markdown returns a Markdown report', async () => {
  await withStubbedFetch({ 'https://widgets.test/': { body: PAGE } }, async () => {
    const response = await worker.fetch(
      new Request('https://citable.test/api/audit?url=https://widgets.test/&format=markdown'),
      env,
    );
    assert.match(response.headers.get('content-type'), /text\/markdown/);
    assert.match(await response.text(), /# AI Visibility Audit/);
  });
});

test('missing url and private hosts are rejected with useful errors', async () => {
  const noUrl = await worker.fetch(new Request('https://citable.test/api/audit', { method: 'POST', body: '{}' }), env);
  assert.equal(noUrl.status, 400);
  assert.equal((await noUrl.json()).error, 'missing_url');

  const privateHost = await worker.fetch(new Request('https://citable.test/api/audit?url=http://127.0.0.1/'), env);
  assert.equal(privateHost.status, 400);
  assert.equal((await privateHost.json()).error, 'private_host');
});

test('rate limiting kicks in and reports a retry-after', async () => {
  await withStubbedFetch({ 'https://widgets.test/': { body: PAGE } }, async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200)}`;
    let limited = null;
    for (let i = 0; i < 15; i += 1) {
      const response = await worker.fetch(
        new Request('https://citable.test/api/audit?url=https://widgets.test/', { headers: { 'cf-connecting-ip': ip } }),
        env,
      );
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    assert.ok(limited, 'expected to be rate limited within 15 requests');
    assert.equal(limited.headers.get('retry-after'), '60');
  });
});

test('unknown routes 404 and OPTIONS preflight succeeds', async () => {
  const missing = await worker.fetch(new Request('https://citable.test/nope'), env);
  assert.equal(missing.status, 404);

  const preflight = await worker.fetch(new Request('https://citable.test/api/audit', { method: 'OPTIONS' }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});

test('/api/health and /api/crawlers expose the registry', async () => {
  const health = await (await worker.fetch(new Request('https://citable.test/api/health'), env)).json();
  assert.equal(health.ok, true);
  assert.ok(health.crawlersTracked > 5);

  const crawlers = await (await worker.fetch(new Request('https://citable.test/api/crawlers'), env)).json();
  assert.ok(crawlers.crawlers.some((crawler) => crawler.token === 'GPTBot'));
});

/* --------------------------------------------- self-service licence check */

test('/api/license lets a buyer confirm a key without spending an audit', async () => {
  const { key } = await issueKey({ email: 'buyer@test.co', secret: SECRET, days: 30 });
  const response = await worker.fetch(new Request(`https://citable.test/api/license?key=${encodeURIComponent(key)}`), env);
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.valid, true);
  assert.equal(data.plan, 'pro');
  assert.equal(data.seats, 1);
  assert.ok(data.expiresAt);

  // It must not echo the key or the buyer's email back to whoever asked —
  // anyone can hit this endpoint with a key they found.
  const body = JSON.stringify(data);
  assert.ok(!body.includes(key), 'the key must not be echoed');
  assert.ok(!body.includes('buyer@test.co'), 'the email must not be disclosed');
});

test('/api/license reports why a key is not accepted', async () => {
  const expired = await issueKey({ email: 'a@b.c', secret: SECRET, days: -1 });
  const expiredData = await (await worker.fetch(new Request(`https://citable.test/api/license?key=${encodeURIComponent(expired.key)}`), env)).json();
  assert.equal(expiredData.valid, false);
  assert.equal(expiredData.reason, 'expired');
  assert.ok(expiredData.expiresAt, 'the holder should see when it lapsed');

  const bogus = await (await worker.fetch(new Request('https://citable.test/api/license?key=CTB1.aaa.bbb'), env)).json();
  assert.equal(bogus.valid, false);
  assert.equal(bogus.reason, 'malformed');

  const missing = await worker.fetch(new Request('https://citable.test/api/license'), env);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, 'missing_key');
});

test('/api/license honours revocations supplied by configuration', async () => {
  const { key, payload } = await issueKey({ email: 'refunded@test.co', secret: SECRET, days: 0 });

  const before = await (await worker.fetch(new Request(`https://citable.test/api/license?key=${encodeURIComponent(key)}`), env)).json();
  assert.equal(before.valid, true);

  // A refund should be a config change, not a redeploy.
  const withRevocation = { ...env, REVOKED_KEYS: `someone_else,${payload.i}` };
  const after = await (await worker.fetch(new Request(`https://citable.test/api/license?key=${encodeURIComponent(key)}`), withRevocation)).json();
  assert.equal(after.valid, false);
  assert.equal(after.reason, 'revoked');
});

test('a revoked key is downgraded to free on the audit endpoint too', async () => {
  const { key, payload } = await issueKey({ email: 'refunded@test.co', secret: SECRET, days: 0 });
  await withStubbedFetch({ 'https://widgets.test/': { body: PAGE } }, async () => {
    const response = await worker.fetch(
      new Request(`https://citable.test/api/audit?url=https://widgets.test/&key=${encodeURIComponent(key)}`),
      { ...env, REVOKED_KEYS: payload.i },
    );
    const data = await response.json();
    assert.equal(data.tier, 'free');
    assert.match(data.licenseWarning, /revoked/);
  });
});

test('/api/license accepts a bearer token as well as a query parameter', async () => {
  const { key } = await issueKey({ email: 'a@b.c', secret: SECRET, days: 30 });
  const data = await (
    await worker.fetch(new Request('https://citable.test/api/license', { headers: { authorization: `Bearer ${key}` } }), env)
  ).json();
  assert.equal(data.valid, true);
});

/* ------------------------------------------------ deploy misconfiguration */

test('an unconfigured checkout does not render a dead buy button', async () => {
  // wrangler.toml ships CHECKOUT_URL as a placeholder. A deploy that never
  // edits it would otherwise show live buy buttons pointing at a 404, and
  // nothing about that fails loudly.
  const placeholder = { ...env, CHECKOUT_URL: 'https://gumroad.com/l/CHANGE-ME' };
  const html = await (await worker.fetch(new Request('https://citable.test/'), placeholder)).text();

  assert.doesNotMatch(html, /href="https:\/\/gumroad\.com\/l\/CHANGE-ME"/);
  assert.match(html, /Checkout not configured/);

  // And with no CHECKOUT_URL at all.
  const bare = await (await worker.fetch(new Request('https://citable.test/'), { LICENSE_SECRET: SECRET })).text();
  assert.match(bare, /Checkout not configured/);
});

test('a configured checkout renders real buy buttons', async () => {
  const html = await (await worker.fetch(new Request('https://citable.test/'), env)).text();
  assert.match(html, /href="https:\/\/checkout\.example\/buy"/);
  assert.doesNotMatch(html, /Checkout not configured/);
});

test('/api/health reports whether the deploy is actually sellable', async () => {
  const healthy = await (await worker.fetch(new Request('https://citable.test/api/health'), env)).json();
  assert.equal(healthy.licensingConfigured, true);
  assert.equal(healthy.checkoutConfigured, true);

  // Neither omission fails loudly on its own: with no verifier every Pro key is
  // rejected, and with no checkout there is nothing to buy.
  const broken = await (
    await worker.fetch(new Request('https://citable.test/api/health'), { CHECKOUT_URL: 'https://x/CHANGE-ME' })
  ).json();
  assert.equal(broken.ok, true, 'the service still serves free audits');
  assert.equal(broken.checkoutConfigured, false);

  // Asserted against the compiled-in key rather than hard-coded false: once a
  // seller runs `--keygen` and commits the public half, a deploy with no secret
  // *is* correctly licensed, and a flat `false` here would fail the day the
  // product was finally configured properly.
  const { LICENSE_PUBLIC_KEY } = await import('../src/core/license.js');
  assert.equal(broken.legacyKeysConfigured, false, 'no secret means no legacy keys');
  assert.equal(broken.portableKeysConfigured, Boolean(LICENSE_PUBLIC_KEY));
  assert.equal(broken.licensingConfigured, Boolean(LICENSE_PUBLIC_KEY));
});

/* --------------------------------------- keys that need no shared secret */

/**
 * `/api/license` gated on `LICENSE_SECRET` before doing anything, and answered
 * 503 `no_secret_configured` when it was absent. That is the same mistake as
 * the CLI's, in a second place: a check for one credential standing in for
 * "can this verify a key at all". A buyer checking a perfectly good CTB2 key
 * was told the service was broken.
 *
 * These tests run against a deploy holding no secret at all, which is the
 * configuration a seller who followed the current instructions actually has.
 */
test('a portable key verifies on a deploy with no LICENSE_SECRET', async () => {
  const { generateSigningPair, issueKey } = await import('../src/core/license.js');
  const pair = await generateSigningPair();
  const { key } = await issueKey({ email: 'buyer@example.com', privateKey: pair.privateKey, days: 0, seats: 2 });

  const { LICENSE_PUBLIC_KEY } = await import('../src/core/license.js');
  const response = await worker.fetch(
    new Request(`https://citable.test/api/license?key=${key}`),
    { CHECKOUT_URL: 'https://checkout.example/buy' },
  );

  if (LICENSE_PUBLIC_KEY) {
    // A pair is compiled in, so the endpoint must actually try the key rather
    // than refusing because no *secret* was set.
    assert.notEqual(response.status, 503, 'a missing secret must not 503 when a public key exists');
    return;
  }

  // Nothing configured at all: say so, and do not pretend the key is valid.
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.valid, false);
  assert.equal(body.reason, 'no_verifier_configured', 'the reason must name the real gap, not the secret');
});

test('health reports the two licence halves separately', async () => {
  // One flag standing for both is how the CLI defect stayed invisible:
  // LICENSE_SECRET was set, licensing looked configured, and keys worked in
  // the web UI and nowhere else.
  const withSecret = await (await worker.fetch(new Request('https://citable.test/api/health'), env)).json();
  assert.equal(withSecret.legacyKeysConfigured, true);
  assert.equal(typeof withSecret.portableKeysConfigured, 'boolean');

  const bare = await (await worker.fetch(new Request('https://citable.test/api/health'), {})).json();
  assert.equal(bare.legacyKeysConfigured, false);
});
