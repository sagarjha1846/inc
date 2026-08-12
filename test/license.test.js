import test from 'node:test';
import assert from 'node:assert/strict';

import { issueKey, tierFor, verifyKey, REVOKED_KEY_IDS } from '../src/core/license.js';

const SECRET = 'test-signing-secret-do-not-use-in-production';

test('an issued key verifies with the same secret', async () => {
  const { key, payload } = await issueKey({ email: 'Buyer@Example.com', secret: SECRET, days: 30 });
  assert.match(key, /^CTB1\./);
  const verified = await verifyKey(key, SECRET);
  assert.equal(verified.valid, true);
  assert.equal(verified.plan, 'pro');
  assert.equal(verified.email, 'buyer@example.com');
  assert.equal(verified.id, payload.i);
  assert.ok(verified.expiresAt);
});

test('a key does not verify with a different secret', async () => {
  const { key } = await issueKey({ email: 'a@b.c', secret: SECRET });
  const verified = await verifyKey(key, 'some-other-secret');
  assert.equal(verified.valid, false);
  assert.equal(verified.reason, 'bad_signature');
});

test('tampering with the payload invalidates the key', async () => {
  const { key } = await issueKey({ email: 'a@b.c', secret: SECRET, plan: 'free' });
  const [prefix, body, signature] = key.split('.');
  const forged = `${prefix}.${Buffer.from(JSON.stringify({ v: 1, i: 'x', e: 'a@b.c', p: 'pro', s: 99, t: 0, x: 0 }))
    .toString('base64url')}.${signature}`;
  assert.notEqual(forged, key);
  assert.equal((await verifyKey(forged, SECRET)).valid, false);
  assert.equal((await verifyKey(`${prefix}.${body}.AAAA`, SECRET)).valid, false);
});

test('malformed keys are rejected without throwing', async () => {
  for (const bad of ['', 'nonsense', 'CTB1.only-two-parts', 'XXXX.a.b', 'CTB1.!!!.###']) {
    const verified = await verifyKey(bad, SECRET);
    assert.equal(verified.valid, false, `expected ${JSON.stringify(bad)} to be invalid`);
  }
});

test('an expired key is reported as expired rather than invalid', async () => {
  const { key } = await issueKey({ email: 'a@b.c', secret: SECRET, days: -1 });
  const verified = await verifyKey(key, SECRET);
  assert.equal(verified.valid, false);
  assert.equal(verified.reason, 'expired');
  assert.ok(verified.expiredAt);
});

test('days: 0 issues a lifetime key', async () => {
  const { key } = await issueKey({ email: 'a@b.c', secret: SECRET, days: 0 });
  const verified = await verifyKey(key, SECRET);
  assert.equal(verified.valid, true);
  assert.equal(verified.expiresAt, null);
});

test('revoked key ids are refused even with a valid signature', async () => {
  const { key, payload } = await issueKey({ email: 'refund@example.com', secret: SECRET, days: 0 });
  assert.equal((await verifyKey(key, SECRET)).valid, true);
  REVOKED_KEY_IDS.add(payload.i);
  try {
    const verified = await verifyKey(key, SECRET);
    assert.equal(verified.valid, false);
    assert.equal(verified.reason, 'revoked');
  } finally {
    REVOKED_KEY_IDS.delete(payload.i);
  }
});

test('tierFor maps keys to tiers and fails closed', async () => {
  const { key } = await issueKey({ email: 'a@b.c', secret: SECRET, days: 10 });
  assert.equal((await tierFor(key, SECRET)).tier, 'pro');
  assert.equal((await tierFor(null, SECRET)).tier, 'free');
  assert.equal((await tierFor('garbage', SECRET)).tier, 'free');
  assert.equal((await tierFor(key, undefined)).tier, 'free');

  const freePlan = await issueKey({ email: 'a@b.c', secret: SECRET, plan: 'free' });
  assert.equal((await tierFor(freePlan.key, SECRET)).tier, 'free');
});

/* ------------------------------------------------- config-driven revocation */

import { parseRevoked } from '../src/core/license.js';

test('parseRevoked accepts the shapes a config value can arrive in', () => {
  assert.deepEqual([...parseRevoked('k_one,k_two')], ['k_one', 'k_two']);
  assert.deepEqual([...parseRevoked(' k_one , k_two ')], ['k_one', 'k_two']);
  assert.deepEqual([...parseRevoked('k_one k_two\nk_three')], ['k_one', 'k_two', 'k_three']);
  assert.deepEqual([...parseRevoked(['k_one', ' k_two '])], ['k_one', 'k_two']);
  assert.deepEqual([...parseRevoked(new Set(['k_one']))], ['k_one']);
  // Empty and absent config must not revoke anything.
  for (const empty of ['', '   ', null, undefined, ',,,']) {
    assert.equal(parseRevoked(empty).size, 0, `${JSON.stringify(empty)} should revoke nothing`);
  }
});

test('a key can be revoked through config without a code change', async () => {
  // Processing a refund should be a config edit, not a source edit plus a
  // redeploy — friction there ends with revocations not happening at all.
  const { key, payload } = await issueKey({ email: 'refunded@example.com', secret: SECRET, days: 0 });
  assert.equal((await verifyKey(key, SECRET)).valid, true);

  const revokedResult = await verifyKey(key, SECRET, { revoked: `other_id,${payload.i}` });
  assert.equal(revokedResult.valid, false);
  assert.equal(revokedResult.reason, 'revoked');

  // Other keys signed with the same secret are unaffected.
  const other = await issueKey({ email: 'still-a-customer@example.com', secret: SECRET, days: 0 });
  assert.equal((await verifyKey(other.key, SECRET, { revoked: payload.i })).valid, true);
});

test('tierFor passes revocations through to verification', async () => {
  const { key, payload } = await issueKey({ email: 'a@b.c', secret: SECRET, days: 30 });
  assert.equal((await tierFor(key, SECRET)).tier, 'pro');

  const resolved = await tierFor(key, SECRET, { revoked: payload.i });
  assert.equal(resolved.tier, 'free');
  assert.equal(resolved.license.reason, 'revoked');
});

test('revocation is checked only after the signature, so forgeries stay forgeries', async () => {
  // A revoked-but-unsigned key must report the signature problem rather than
  // leaking that the id was on the deny-list.
  const { payload } = await issueKey({ email: 'a@b.c', secret: SECRET });
  const forged = `CTB1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  const result = await verifyKey(forged, SECRET, { revoked: payload.i });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'bad_signature');
});

/* ------------------------------------------------------ key re-derivation */

import { keyFromPayload } from '../src/core/license.js';

test('a key can be re-derived from its ledger payload', async () => {
  // The support case: a buyer lost their key. Re-deriving returns the key they
  // were already sent, rather than minting a second live key for one purchase
  // — two keys for one sale cannot later be revoked as a unit.
  const { key, payload } = await issueKey({ email: 'alice@example.com', secret: SECRET, days: 365 });

  const rederived = await keyFromPayload(payload, SECRET);
  assert.equal(rederived, key, 're-derivation must be deterministic');
  assert.equal((await verifyKey(rederived, SECRET)).valid, true);
});

test('re-derivation is bound to the signing secret', async () => {
  const { payload } = await issueKey({ email: 'alice@example.com', secret: SECRET });
  const wrong = await keyFromPayload(payload, 'a-different-secret-entirely-here');
  assert.equal((await verifyKey(wrong, SECRET)).valid, false);
});

test('a re-derived key carries the original expiry, not a fresh one', async () => {
  // Re-issuing with issueKey would silently extend the licence; re-deriving
  // must not.
  const { payload } = await issueKey({ email: 'alice@example.com', secret: SECRET, days: 1 });
  const rederived = await keyFromPayload(payload, SECRET);
  const verified = await verifyKey(rederived, SECRET);
  assert.equal(verified.expiresAt, new Date(payload.x * 1000).toISOString());
});

/* ------------------------------------------- portable keys a buyer can use */

/**
 * The defect these exist for: HMAC is symmetric, so verifying a CTB1 key needs
 * the same secret that mints one. The published package ships no secret — quite
 * correctly — so a buyer who paid, set CITABLE_KEY and ran the documented
 * command was told "license key not accepted" and given the free tier. Making
 * it work would have meant handing every buyer the key-minting secret.
 */
test('a CTB2 key verifies with no secret anywhere', async () => {
  const { generateSigningPair, issueKey, tierFor } = await import('../src/core/license.js');
  const pair = await generateSigningPair();
  const { key } = await issueKey({ email: 'buyer@example.com', privateKey: pair.privateKey, days: 0 });

  assert.ok(key.startsWith('CTB2.'), 'a key signed with the private half is a CTB2 key');

  // No secret argument at all — this is a buyer's machine.
  const resolved = await tierFor(key, undefined, { publicKey: pair.publicX });
  assert.equal(resolved.tier, 'pro');
  assert.equal(resolved.license.email, 'buyer@example.com');
  assert.equal(resolved.license.expiresAt, null);
});

test('the public half cannot mint keys', async () => {
  // The whole reason it is safe to ship. A key signed by any other pair must
  // fail, or publishing the verifier would publish the ability to forge.
  const { generateSigningPair, issueKey, verifyKey } = await import('../src/core/license.js');
  const seller = await generateSigningPair();
  const forger = await generateSigningPair();

  const forged = await issueKey({ email: 'thief@example.com', privateKey: forger.privateKey, days: 0 });
  const checked = await verifyKey(forged.key, undefined, { publicKey: seller.publicX });
  assert.equal(checked.valid, false);
  assert.equal(checked.reason, 'bad_signature');

  // And the shipped public value carries no private component.
  assert.equal(seller.publicKey.d, undefined, 'an exported public JWK must have no d');
});

test('a tampered CTB2 payload is refused', async () => {
  const { generateSigningPair, issueKey, verifyKey } = await import('../src/core/license.js');
  const pair = await generateSigningPair();
  const { key } = await issueKey({ email: 'buyer@example.com', privateKey: pair.privateKey, days: 30 });
  const [prefix, body, signature] = key.split('.');

  // Re-sign nothing; just swap the payload for a lifetime one.
  const upgraded = Buffer.from(JSON.stringify({ v: 1, i: 'x', e: 'b@c.d', p: 'pro', s: 99, t: 1, x: 0 }))
    .toString('base64url');
  const forged = `${prefix}.${upgraded}.${signature}`;
  assert.equal((await verifyKey(forged, undefined, { publicKey: pair.publicX })).valid, false);

  // A flipped signature byte too.
  const flipped = `${prefix}.${body}.${signature.slice(0, -2)}${signature.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
  assert.equal((await verifyKey(flipped, undefined, { publicKey: pair.publicX })).valid, false);
});

test('CTB2 signing is deterministic, so a lost key comes back identical', async () => {
  // "I lost my key" is the most common support request a one-time purchase
  // generates. Re-issuing a *different* key would leave the buyer's original
  // still live, accumulating keys that cannot be revoked as a set. ECDSA would
  // have broken this; Ed25519 signatures are deterministic.
  const { generateSigningPair, keyFromPayload } = await import('../src/core/license.js');
  const pair = await generateSigningPair();
  const payload = { v: 1, i: 'k_fixed', e: 'buyer@example.com', p: 'pro', s: 1, t: 1786000000, x: 0 };

  const first = await keyFromPayload(payload, { privateKey: pair.privateKey });
  const second = await keyFromPayload(payload, { privateKey: pair.privateKey });
  assert.equal(first, second);
});

test('an unconfigured public key refuses CTB2 keys rather than accepting them', async () => {
  // Failing open here would make every forged key valid on a fresh install.
  const { generateSigningPair, issueKey, verifyKey, LICENSE_PUBLIC_KEY } = await import('../src/core/license.js');
  const pair = await generateSigningPair();
  const { key } = await issueKey({ email: 'buyer@example.com', privateKey: pair.privateKey, days: 0 });

  const checked = await verifyKey(key, undefined, { publicKey: '' });
  assert.equal(checked.valid, false);
  assert.equal(checked.reason, LICENSE_PUBLIC_KEY ? 'bad_signature' : 'no_public_key_configured');
});

test('CTB1 keys still verify where the secret is configured', async () => {
  // The Worker holds LICENSE_SECRET, so keys already sold must keep working.
  const { issueKey, tierFor } = await import('../src/core/license.js');
  const secret = 'a-legacy-signing-secret-of-ample-length';
  const { key } = await issueKey({ email: 'old@example.com', secret, days: 0 });

  assert.ok(key.startsWith('CTB1.'));
  assert.equal((await tierFor(key, secret)).tier, 'pro');
  // And without it, they degrade rather than throwing.
  const without = await tierFor(key, undefined);
  assert.equal(without.tier, 'free');
  assert.equal(without.license.reason, 'no_secret_configured');
});
