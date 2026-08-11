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
