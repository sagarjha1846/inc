/**
 * The key-issuing script.
 *
 * This is the revenue path. It runs once per sale, by hand, and its output is
 * pasted into an email to a buyer. A defect here is not a wrong number in a
 * report: it is either a paying customer holding a key that does not work, or
 * a key that works when it should not.
 *
 * It is a CLI, so it is exercised as one — spawned as a subprocess with a real
 * environment and a real ledger file, the way it is actually used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { verifyKey } from '../src/core/license.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'test-signing-secret-of-ample-length';

/**
 * Run the script from a copy in a temporary directory.
 *
 * The real script would append test rows to the ledger of actual sales, so it
 * is copied — but the copy has to sit at the same depth. The ledger path is
 * `../licenses.ndjson` *relative to the script*, so a copy one level shallower
 * writes outside the sandbox, into a file shared by every test run. Mirroring
 * the `scripts/` directory keeps the ledger where the test can see it and
 * nowhere else.
 */
async function scriptIn(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'citable-keygen-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(path.join(dir, 'scripts'));
  const target = path.join(dir, 'scripts', 'issue-key.mjs');
  await copyFile(path.join(ROOT, 'scripts', 'issue-key.mjs'), target);
  // The copy imports ../src/core/license.js, so point that at the real module.
  const source = await readFile(target, 'utf8');
  await writeFile(target, source.replace("'../src/core/license.js'", `'${path.join(ROOT, 'src/core/license.js')}'`));
  return dir;
}

function run(dir, args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(dir, 'scripts', 'issue-key.mjs'), ...args],
      { cwd: dir, env: { ...process.env, CITABLE_LICENSE_SECRET: SECRET, ...env } },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

/** The key is the only line that looks like one. */
const keyFrom = (stdout) => stdout.split('\n').map((l) => l.trim()).find((l) => /^CTB1\./.test(l));

test('a key issued for a buyer verifies against the same secret', async (t) => {
  const dir = await scriptIn(t);
  const result = await run(dir, ['buyer@example.com']);

  assert.equal(result.code, 0, result.stderr);
  const key = keyFrom(result.stdout);
  assert.ok(key, `no key in output:\n${result.stdout}`);

  const verified = await verifyKey(key, SECRET);
  assert.equal(verified.valid, true);
  assert.equal(verified.plan, 'pro');
  assert.equal(verified.email, 'buyer@example.com');
  assert.equal(verified.expiresAt, null, 'the default is a lifetime key, matching a one-time purchase');
});

test('the key it prints is the key it tells the buyer to use', async (t) => {
  // The output contains the key three times: on its own, and inside two
  // ready-to-send instructions. A mismatch means a buyer pastes something that
  // does not work, which reads as the product being broken.
  const dir = await scriptIn(t);
  const { stdout } = await run(dir, ['buyer@example.com']);

  const occurrences = [...stdout.matchAll(/CTB1\.[\w-]+\.[\w-]+/g)].map((m) => m[0]);
  assert.ok(occurrences.length >= 2, 'the key should appear in the send-to-buyer instructions');
  assert.equal(new Set(occurrences).size, 1, 'every printed key must be identical');
});

test('--days controls expiry, and a typo cannot mint a lifetime key', async (t) => {
  const dir = await scriptIn(t);

  const annual = await verifyKey(keyFrom((await run(dir, ['a@b.co', '--days', '365'])).stdout), SECRET);
  assert.equal(annual.valid, true);
  assert.ok(annual.expiresAt, 'an annual key must carry an expiry');

  const lifetime = await verifyKey(keyFrom((await run(dir, ['a@b.co', '--days', '0'])).stdout), SECRET);
  assert.equal(lifetime.expiresAt, null);

  // Negative days is a slip, and it must produce something already expired
  // rather than the most valuable key the product sells.
  const negative = await verifyKey(keyFrom((await run(dir, ['a@b.co', '--days', '-1'])).stdout), SECRET);
  assert.equal(negative.valid, false);
  assert.equal(negative.reason, 'expired');
});

test('a key does not verify against a different secret', async (t) => {
  const dir = await scriptIn(t);
  const key = keyFrom((await run(dir, ['a@b.co'])).stdout);
  const verified = await verifyKey(key, 'a-completely-different-secret-value');
  assert.equal(verified.valid, false);
  assert.equal(verified.reason, 'bad_signature');
});

test('--verify accepts a real key and rejects a tampered one', async (t) => {
  const dir = await scriptIn(t);
  const key = keyFrom((await run(dir, ['a@b.co'])).stdout);

  const good = await run(dir, ['--verify', key]);
  assert.equal(good.code, 0);
  assert.match(good.stdout, /"valid": true/);

  const bad = await run(dir, ['--verify', `${key.slice(0, -4)}ZZZZ`]);
  assert.notEqual(bad.code, 0, 'a tampered key must exit non-zero so a script can rely on it');
  assert.match(bad.stdout, /"valid": false/);
});

test('the ledger records what was sold', async (t) => {
  // The ledger is how a refund is honoured and how a leaked key is revoked, so
  // it has to carry the key id that REVOKED_KEY_IDS is keyed on.
  const dir = await scriptIn(t);
  const { stdout } = await run(dir, ['ledger@example.com', '--days', '365', '--seats', '3']);
  const key = keyFrom(stdout);

  const rows = (await readFile(path.join(dir, 'licenses.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(rows.length, 1);
  const row = JSON.parse(rows[0]);

  assert.equal(row.e, 'ledger@example.com');
  assert.equal(row.s, 3);
  assert.ok(row.issuedAt, 'the row should be dated');
  assert.equal((await verifyKey(key, SECRET)).id, row.i, 'the ledger id must match the issued key');

  // And it appends rather than overwrites: losing earlier sales would make
  // refunds unhonourable.
  await run(dir, ['second@example.com']);
  const after = (await readFile(path.join(dir, 'licenses.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(after.length, 2);
});

test('the signing secret never appears in the output', async (t) => {
  // The output is pasted into an email. A secret leaking there hands every
  // recipient the ability to mint their own keys.
  const dir = await scriptIn(t);
  const result = await run(dir, ['buyer@example.com']);
  assert.doesNotMatch(result.stdout, new RegExp(SECRET));
  assert.doesNotMatch(result.stderr, new RegExp(SECRET));
  const ledger = await readFile(path.join(dir, 'licenses.ndjson'), 'utf8');
  assert.doesNotMatch(ledger, new RegExp(SECRET));
});

test('it refuses to run without a usable secret', async (t) => {
  const dir = await scriptIn(t);

  const missing = await run(dir, ['a@b.co'], { CITABLE_LICENSE_SECRET: '' });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /CITABLE_LICENSE_SECRET/);

  const tooShort = await run(dir, ['a@b.co'], { CITABLE_LICENSE_SECRET: 'short' });
  assert.notEqual(tooShort.code, 0, 'a weak secret undermines every key ever issued');
  assert.match(tooShort.stderr, /too short/);
});

test('it refuses input that is not an email address', async (t) => {
  const dir = await scriptIn(t);
  const result = await run(dir, ['not-an-email']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not look like an email/);
});

test('--list reports nothing before any sale', async (t) => {
  const dir = await scriptIn(t);
  const empty = await run(dir, ['--list']);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /No keys issued yet/);

  await run(dir, ['a@b.co']);
  const populated = await run(dir, ['--list']);
  assert.match(populated.stdout, /a@b\.co/);
});

test('--find re-derives the exact key a buyer was already sold', async (t) => {
  // "I lost my key" is the most common support request a one-time purchase
  // generates. Re-issuing would mint a *different* key and leave the buyer's
  // original still valid, so the same signed value has to come back.
  const dir = await scriptIn(t);
  const original = keyFrom((await run(dir, ['buyer@example.com', '--days', '365', '--seats', '2'])).stdout);

  const found = await run(dir, ['--find', 'buyer@example.com']);
  assert.equal(found.code, 0, found.stderr);
  assert.equal(keyFrom(found.stdout), original, 're-derivation must return the identical key');
});

test('--find is case-insensitive and reports an unknown buyer', async (t) => {
  const dir = await scriptIn(t);
  const original = keyFrom((await run(dir, ['Buyer@Example.com'])).stdout);

  const found = await run(dir, ['--find', 'BUYER@EXAMPLE.COM']);
  assert.equal(keyFrom(found.stdout), original, 'an address is the same address in any case');

  const missing = await run(dir, ['--find', 'nobody@example.com']);
  assert.notEqual(missing.code, 0, 'an unknown buyer must not exit as though it succeeded');
});
