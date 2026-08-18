/**
 * Cloudflare Worker entry point.
 *
 * Runs entirely on the free tier: no database, no KV requirement, no origin
 * server. License keys are verified with an HMAC (see core/license.js), so the
 * only piece of state the product needs is a secret in the environment.
 */

import { auditUrl } from '../core/audit.js';
import { renderHtml, renderMarkdown } from '../core/report.js';
import { LICENSE_PUBLIC_KEY, tierFor, verifyKey } from '../core/license.js';
import { AI_CRAWLERS } from '../core/robots.js';
import { FetchError } from '../core/fetch.js';
import { renderApp } from './ui.js';
import { SAMPLE_RESULT } from './sample.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/**
 * Per-isolate rate limiting.
 *
 * Workers spin up many isolates, so this caps abuse from a single hot isolate
 * rather than enforcing a global quota — good enough to stop a runaway script,
 * and it costs nothing. Bind a KV namespace named RATE and it upgrades to a
 * real global limit.
 */
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;

function localRateLimit(ip) {
  const now = Date.now();
  const record = hits.get(ip);
  if (!record || now - record.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    if (hits.size > 5000) hits.clear();
    return { ok: true, remaining: MAX_PER_WINDOW - 1 };
  }
  record.count += 1;
  return { ok: record.count <= MAX_PER_WINDOW, remaining: Math.max(0, MAX_PER_WINDOW - record.count) };
}

async function rateLimit(env, ip) {
  if (!env.RATE) return localRateLimit(ip);
  const key = `rl:${ip}:${Math.floor(Date.now() / WINDOW_MS)}`;
  const current = Number.parseInt((await env.RATE.get(key)) || '0', 10);
  if (current >= MAX_PER_WINDOW) return { ok: false, remaining: 0 };
  await env.RATE.put(key, String(current + 1), { expirationTtl: 120 });
  return { ok: true, remaining: MAX_PER_WINDOW - current - 1 };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(), ...extraHeaders },
  });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    switch (url.pathname) {
      case '/':
        return new Response(renderApp({ priceUrl: env.CHECKOUT_URL || '#pricing' }), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
        });

      // A full sample report, so a visitor can see what Pro actually produces
      // before deciding to run anything or pay for it.
      case '/demo':
        return new Response(
          renderApp({ priceUrl: env.CHECKOUT_URL || '#pricing', demoResult: SAMPLE_RESULT }),
          { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } },
        );

      case '/api/health':
        return json({
          ok: true,
          service: 'citable',
          crawlersTracked: AI_CRAWLERS.length,
          // Both are easy to forget on a first deploy and neither fails loudly
          // on its own: without a secret every Pro key is rejected, and without
          // a checkout link there is no way to buy one.
          // Two independent halves. LICENSE_SECRET verifies legacy CTB1 keys
          // here on the server; LICENSE_PUBLIC_KEY verifies CTB2 keys, which is
          // the only kind a buyer can use on their own machine. A deploy with
          // the first and not the second sells keys that work in the web UI and
          // nowhere else, which is how the CLI silently gave buyers the free
          // tier — so both are reported rather than one flag standing for both.
          licensingConfigured: Boolean(env.LICENSE_SECRET) || Boolean(LICENSE_PUBLIC_KEY),
          legacyKeysConfigured: Boolean(env.LICENSE_SECRET),
          portableKeysConfigured: Boolean(LICENSE_PUBLIC_KEY),
          checkoutConfigured: Boolean(env.CHECKOUT_URL) && !/CHANGE-ME/i.test(env.CHECKOUT_URL || ''),
        });

      case '/api/crawlers':
        return json({ crawlers: AI_CRAWLERS });

      // Lets a buyer confirm their key works without spending an audit on it,
      // which is most of what a support email would otherwise ask.
      case '/api/license':
        return handleLicense(request, env, url);

      case '/api/audit':
        return handleAudit(request, env, url);

      // Dogfooding: the auditor's own site passes its own audit.
      case '/robots.txt':
        return new Response(ownRobots(url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8' } });

      case '/llms.txt':
        return new Response(ownLlms(url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8' } });

      // robots.txt declares this URL (see ownRobots below) — the sitemap
      // check we run against every other site would flag a declared-but-404
      // sitemap as a finding, so the auditor's own site needs to serve one.
      case '/sitemap.xml':
        return new Response(ownSitemap(url.origin), { headers: { 'content-type': 'application/xml; charset=utf-8' } });

      default:
        return json({ error: 'not_found' }, 404);
    }
  },
};

async function handleAudit(request, env, url) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'anon';

  let target;
  let key;
  let format = 'json';

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json', message: 'Request body must be JSON.' }, 400);
    }
    target = body.url;
    key = body.key;
    format = body.format || 'json';
  } else if (request.method === 'GET') {
    target = url.searchParams.get('url');
    key = url.searchParams.get('key');
    format = url.searchParams.get('format') || 'json';
  } else {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const authHeader = request.headers.get('authorization');
  if (!key && authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    key = authHeader.slice(7).trim();
  }

  if (!target) {
    return json({ error: 'missing_url', message: 'Pass a `url` to audit.' }, 400);
  }

  const limit = await rateLimit(env, ip);
  if (!limit.ok) {
    return json(
      { error: 'rate_limited', message: 'Too many audits from this address. Wait a minute, or use the CLI locally — it has no limit.' },
      429,
      { 'retry-after': '60' },
    );
  }

  const { tier, license } = await tierFor(key, env.LICENSE_SECRET, { revoked: env.REVOKED_KEYS });

  try {
    const result = await auditUrl(target, {
      tier,
      fetchOptions: {
        timeoutMs: 12000,
        maxBytes: 2_000_000,
      },
    });

    if (license && !license.valid && key) {
      result.licenseWarning = `Key not accepted (${license.reason}); served on the free tier.`;
    }

    if (format === 'markdown') {
      return new Response(renderMarkdown(result), {
        headers: { 'content-type': 'text/markdown; charset=utf-8', ...corsHeaders() },
      });
    }
    if (format === 'html') {
      return new Response(renderHtml(result), {
        headers: { 'content-type': 'text/html; charset=utf-8', ...corsHeaders() },
      });
    }
    return json(result, 200, { 'x-ratelimit-remaining': String(limit.remaining) });
  } catch (error) {
    if (error instanceof FetchError) {
      return json({ error: error.code, message: error.message }, error.code === 'private_host' ? 400 : 502);
    }
    return json({ error: 'audit_failed', message: (error && error.message) || 'Unknown error' }, 500);
  }
}

async function handleLicense(request, env, url) {
  const key = url.searchParams.get('key') || (request.headers.get('authorization') || '').replace(/^bearer /i, '').trim();
  if (!key) return json({ error: 'missing_key', message: 'Pass a `key` to check.' }, 400);
  // Only a deploy with neither half configured can verify nothing. Gating on
  // LICENSE_SECRET alone refused CTB2 keys — the portable kind, which need no
  // secret — with a 503, so a buyer checking a perfectly good key was told the
  // service was broken. The same mistake as the CLI's, in a second place: a
  // check for one credential standing in for "can this verify a key at all".
  if (!env.LICENSE_SECRET && !LICENSE_PUBLIC_KEY) {
    return json({ valid: false, reason: 'no_verifier_configured' }, 503);
  }

  const license = await verifyKey(key, env.LICENSE_SECRET, { revoked: env.REVOKED_KEYS });
  // Deliberately never echoes the key back, and reports only what the holder
  // already knows about their own licence.
  return json({
    valid: license.valid,
    reason: license.valid ? null : license.reason,
    plan: license.valid ? license.plan : null,
    seats: license.valid ? license.seats : null,
    expiresAt: license.valid ? license.expiresAt : (license.expiredAt ?? null),
  });
}

function ownRobots(origin) {
  const citation = AI_CRAWLERS.filter((crawler) => crawler.purpose !== 'training');
  const lines = ['# Citable — we practise what we audit.', ''];
  for (const crawler of citation) {
    lines.push(`User-agent: ${crawler.token}`);
    lines.push('Allow: /');
    lines.push('');
  }
  lines.push('User-agent: *');
  lines.push('Allow: /');
  lines.push('');
  lines.push(`Sitemap: ${origin}/sitemap.xml`);
  lines.push('');
  return lines.join('\n');
}

function ownSitemap(origin) {
  const paths = ['/', '/demo'];
  const urls = paths
    .map((path) => `  <url>\n    <loc>${origin}${path}</loc>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function ownLlms(origin) {
  return `# Citable

> Citable audits whether AI answer engines — ChatGPT, Claude, Perplexity and Google AI Overviews — can crawl, read and cite a web page, and generates the exact files needed to fix what it finds.

## Core pages

- [Home](${origin}/): Run a free audit on any URL.
- [API](${origin}/api/audit?url=example.com): JSON audit endpoint. Pass \`url\`, optional \`key\`, optional \`format=markdown\`.
- [Crawler registry](${origin}/api/crawlers): Every AI crawler Citable tracks, with vendor, surface and purpose.
- [Licence check](${origin}/api/license): Confirm a Pro key without running an audit.
- [Sample report](${origin}/demo): A full Pro-tier audit of an example page.

## What it checks

- Crawler access: whether robots.txt permits the crawlers that produce citations.
- Readable content: whether the answer text exists in HTML without JavaScript.
- Answer structure: whether a model can lift a clean answer from the page.
- Structured data: whether the page states its facts machine-readably.
- Metadata and authority: title, description, canonical, authorship and freshness.
`;
}
