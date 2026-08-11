/**
 * License keys, verified offline.
 *
 * A key is a signed payload, not a database row: the buyer's plan and expiry
 * travel inside the key and are checked with an HMAC. That means the CLI can
 * validate a Pro key with no network call, the hosted worker needs no
 * database, and the whole billing side of the product costs nothing to run.
 *
 * The trade-off is that keys cannot be revoked by deleting a record, so
 * `REVOKED_KEY_IDS` carries a small deny-list for refunds and leaks, and keys
 * carry an expiry so a subscription lapse eventually closes the door.
 */

const PREFIX = 'CTB1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
export async function issueKey({ email, plan = 'pro', days = 365, seats = 1, secret, id }) {
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

  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${PREFIX}.${body}`));
  const key = `${PREFIX}.${body}.${toBase64Url(new Uint8Array(signature).slice(0, 24))}`;
  return { key, payload };
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
  if (parts.length !== 3 || parts[0] !== PREFIX) return { valid: false, reason: 'malformed' };

  let payload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(parts[1])));
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  let signatureOk = false;
  try {
    const expected = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${PREFIX}.${parts[1]}`));
    const truncated = toBase64Url(new Uint8Array(expected).slice(0, 24));
    // Both sides are fixed-length derived values; compare without early exit.
    signatureOk = timingSafeEqual(truncated, parts[2]);
  } catch {
    return { valid: false, reason: 'verify_failed' };
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
  if (!secret) return { tier: 'free', license: { valid: false, reason: 'no_secret_configured' } };
  const license = await verifyKey(key, secret, options);
  return { tier: license.valid && license.plan !== 'free' ? 'pro' : 'free', license };
}
