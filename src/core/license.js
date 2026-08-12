/**
 * License keys, verified offline.
 *
 * A key is a signed payload, not a database row: the buyer's plan and expiry
 * travel inside the key and are checked against a signature. That means the CLI
 * can validate a Pro key with no network call, the hosted worker needs no
 * database, and the whole billing side of the product costs nothing to run.
 *
 * The trade-off is that keys cannot be revoked by deleting a record, so
 * `REVOKED_KEY_IDS` carries a small deny-list for refunds and leaks, and keys
 * carry an expiry so a subscription lapse eventually closes the door.
 *
 * ## Why there are two formats
 *
 * `CTB1` keys are HMAC-signed, and HMAC is symmetric: verifying a key requires
 * the same secret that signs one. On the server that is fine — the worker holds
 * `LICENSE_SECRET` and buyers never see it. On the CLI it is not, and the
 * consequence was that a buyer who paid and followed the instructions got the
 * free tier, because the published package quite correctly ships no secret.
 * The only way to make it work was to hand every buyer the key-minting secret.
 *
 * `CTB2` keys are Ed25519-signed. The private half stays with the seller; the
 * public half is a constant below and ships in the package, where it lets
 * anyone verify a key and nobody mint one. Ed25519 rather than ECDSA because
 * its signatures are deterministic, which is what lets a buyer who lost their
 * key be sent the identical one rather than a second live key for one sale.
 *
 * Both are verified here: `CTB1` wherever a secret is configured, so existing
 * keys and the worker keep working, and `CTB2` everywhere.
 */

const PREFIX = 'CTB1';
const PREFIX_V2 = 'CTB2';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The public half of the signing key, as the `x` value of an Ed25519 JWK.
 *
 * Safe to publish — that is the entire point. Generate a pair with
 * `node scripts/issue-key.mjs --keygen`, which writes the private half to
 * `license.private.json` (gitignored) and prints the line to paste here.
 *
 * Empty means no pair has been generated yet, and every `CTB2` key is refused
 * with `no_public_key_configured` rather than silently accepted.
 */
export const LICENSE_PUBLIC_KEY = '';

/** Ed25519 across Node, workerd, Deno and Bun. Null if the runtime lacks it. */
async function ed25519Key(jwk, usage) {
  try {
    return await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, [usage]);
  } catch {
    return null;
  }
}

const publicJwk = (x) => ({ kty: 'OKP', crv: 'Ed25519', x, ext: true, key_ops: ['verify'] });

/**
 * Key ids revoked after a refund or a public leak.
 *
 * Compiled-in entries are the fallback. Prefer passing revocations at call
 * time — the worker reads them from a `REVOKED_KEYS` environment variable — so
 * that processing a refund is a config change rather than a source edit and a
 * redeploy. Requiring a deploy per refund is the kind of friction that ends
 * with revocations simply not happening.
 */
export const REVOKED_KEY_IDS = new Set([]);

/** Parse a comma/whitespace separated revocation list from config. */
export function parseRevoked(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map((entry) => String(entry).trim()).filter(Boolean));
  return new Set(
    String(value)
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  if (!secret) throw new Error('A signing secret is required.');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/**
 * Issue a key.
 * `days: 0` mints a lifetime key, which is what a one-time purchase gets.
 */
export async function issueKey({ email, plan = 'pro', days = 365, seats = 1, secret, privateKey, id }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    i: id || `k_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    e: String(email || '').toLowerCase().trim(),
    p: plan,
    s: seats,
    t: now,
    // Exactly 0 means "never expires" (a one-time purchase). Any other value
    // is an offset, including a negative one — a typo in the keygen must not
    // silently mint a lifetime key.
    x: days === 0 ? 0 : now + Math.round(days * 86400),
  };

  return { key: await keyFromPayload(payload, { secret, privateKey }), payload };
}

/**
 * Re-derive the exact key for a payload already recorded in the ledger.
 *
 * Signing is deterministic, so a buyer who lost their key gets the same one
 * back rather than a second live key for one purchase — which would otherwise
 * accumulate keys that can never be revoked as a set.
 */
export async function keyFromPayload(payload, signer) {
  // Accepts a bare secret for callers that predate CTB2, so nothing that used
  // to sign an HMAC key silently starts producing a format it cannot verify.
  const { secret, privateKey } = typeof signer === 'string' ? { secret: signer } : (signer || {});
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));

  if (privateKey) {
    const key = await ed25519Key(privateKey, 'sign');
    if (!key) throw new Error('This runtime has no Ed25519 support, so CTB2 keys cannot be signed here.');
    const signature = await crypto.subtle.sign('Ed25519', key, encoder.encode(`${PREFIX_V2}.${body}`));
    return `${PREFIX_V2}.${body}.${toBase64Url(new Uint8Array(signature))}`;
  }

  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${PREFIX}.${body}`));
  return `${PREFIX}.${body}.${toBase64Url(new Uint8Array(signature).slice(0, 24))}`;
}

/** Generate a signing pair. The private half never leaves the seller. */
export async function generateSigningPair() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey, publicKey, publicX: publicKey.x };
}

/**
 * Verify a key.
 * Always resolves — an invalid key is a normal outcome, not an exception.
 */
export async function verifyKey(key, secret, options = {}) {
  const revoked = parseRevoked(options.revoked);
  const raw = String(key || '').trim();
  if (!raw) return { valid: false, reason: 'missing' };

  const parts = raw.split('.');
  if (parts.length !== 3 || (parts[0] !== PREFIX && parts[0] !== PREFIX_V2)) {
    return { valid: false, reason: 'malformed' };
  }

  let payload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(parts[1])));
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  let signatureOk = false;
  if (parts[0] === PREFIX_V2) {
    // The public key is compiled in, so this path needs nothing configured and
    // works in the published package — which is the whole reason it exists.
    const x = options.publicKey || LICENSE_PUBLIC_KEY;
    if (!x) return { valid: false, reason: 'no_public_key_configured', payload };
    try {
      const key = await ed25519Key(publicJwk(x), 'verify');
      if (!key) return { valid: false, reason: 'ed25519_unsupported', payload };
      signatureOk = await crypto.subtle.verify(
        'Ed25519',
        key,
        fromBase64Url(parts[2]),
        encoder.encode(`${PREFIX_V2}.${parts[1]}`),
      );
    } catch {
      return { valid: false, reason: 'verify_failed', payload };
    }
  } else {
    if (!secret) return { valid: false, reason: 'no_secret_configured', payload };
    try {
      const expected = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${PREFIX}.${parts[1]}`));
      const truncated = toBase64Url(new Uint8Array(expected).slice(0, 24));
      // Both sides are fixed-length derived values; compare without early exit.
      signatureOk = timingSafeEqual(truncated, parts[2]);
    } catch {
      return { valid: false, reason: 'verify_failed' };
    }
  }
  if (!signatureOk) return { valid: false, reason: 'bad_signature' };

  if (REVOKED_KEY_IDS.has(payload.i) || revoked.has(payload.i)) {
    return { valid: false, reason: 'revoked', payload };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.x && payload.x < now) {
    return { valid: false, reason: 'expired', payload, expiredAt: new Date(payload.x * 1000).toISOString() };
  }

  return {
    valid: true,
    plan: payload.p || 'pro',
    email: payload.e || null,
    seats: payload.s || 1,
    id: payload.i,
    expiresAt: payload.x ? new Date(payload.x * 1000).toISOString() : null,
    payload,
  };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Resolve the tier for a request, given an optional key. */
export async function tierFor(key, secret, options = {}) {
  if (!key) return { tier: 'free', license: null };
  // No early return on a missing secret: a CTB2 key needs no secret, and
  // refusing it here was exactly the bug — a buyer with a valid key and a
  // correctly secret-free install was told the key was not accepted.
  const license = await verifyKey(key, secret, options);
  return { tier: license.valid && license.plan !== 'free' ? 'pro' : 'free', license };
}
