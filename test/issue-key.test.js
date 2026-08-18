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

/** The key is the only line that looks like one, in either format. */
const keyFrom = (stdout) => stdout.split('\n').map((l) => l.trim()).find((l) => /^CTB[12]\./.test(l));

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

test('a keyboard-neighbour typo in --days is refused, not silently reinterpreted', async (t) => {
  // Number.parseInt reads as much of the string as looks like a number and
  // discards the rest without complaint. "36o" -- an easy slip for "360", 0
  // and o sit next to each other -- used to parse as 36: a real, working key
  // that expires in a twelfth of what was intended, with nothing in the
  // output distinguishing it from a deliberate --days 36.
  const dir = await scriptIn(t);
  const result = await run(dir, ['a@b.co', '--days', '36o']);
  assert.notEqual(result.code, 0, 'a typo must not exit clean');
  assert.match(result.stderr, /--days must be a whole number/);
  assert.doesNotMatch(result.stdout, /CTB[12]\./, 'no key should be issued for an unparseable term');
});

test('--seats rejects a negative count instead of issuing a licence for it', async (t) => {
  // Number.parseInt('-3', 10) || 1 only falls back on 0 or NaN -- a negative
  // number is truthy, so it parsed clean and issued a licence for -3 seats.
  const dir = await scriptIn(t);
  const negative = await run(dir, ['a@b.co', '--seats', '-3']);
  assert.notEqual(negative.code, 0, 'negative seats must not exit clean');
  assert.match(negative.stderr, /--seats must be at least 1/);
  assert.doesNotMatch(negative.stdout, /CTB[12]\./, 'no key should be issued for negative seats');

  const typo = await run(dir, ['a@b.co', '--seats', '3x']);
  assert.notEqual(typo.code, 0, 'a typo must not exit clean');
  assert.match(typo.stderr, /--seats must be a whole number/);
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

/* ---------------------------------------------- portable keys, end to end */

/**
 * The full seller sequence, run as a seller runs it: generate a pair, issue a
 * key, verify it. This is the path a real sale takes, and every step of it was
 * broken in a different way before — the key format could not be verified on a
 * buyer's machine at all, and `--verify` reported a freshly issued key as
 * invalid because the public half was not yet committed.
 */
test('keygen, issue and verify work as one sequence', async (t) => {
  const dir = await scriptIn(t);
  const noSecret = { CITABLE_LICENSE_SECRET: '' };

  const keygen = await run(dir, ['--keygen'], noSecret);
  assert.equal(keygen.code, 0, keygen.stderr);
  assert.match(keygen.stdout, /LICENSE_PUBLIC_KEY = '[A-Za-z0-9_-]{20,}'/, 'prints the line to paste');

  const written = JSON.parse(await readFile(path.join(dir, 'license.private.json'), 'utf8'));
  assert.equal(written.crv, 'Ed25519');
  assert.ok(written.d, 'the private half must be written');

  // Issued with no HMAC secret at all — the private key is the only credential.
  const issued = await run(dir, ['buyer@example.com'], noSecret);
  assert.equal(issued.code, 0, issued.stderr);
  const key = issued.stdout.split('\n').map((l) => l.trim()).find((l) => /^CTB2\./.test(l));
  assert.ok(key, `no CTB2 key in output:\n${issued.stdout}`);

  // Verified before the public constant is committed, which is the state a
  // seller is actually in between running keygen and editing the source.
  const verified = await run(dir, ['--verify', key], noSecret);
  assert.equal(verified.code, 0, 'a key just issued must verify');
  assert.match(verified.stdout, /"valid": true/);
  assert.match(verified.stdout, /buyer@example\.com/);

  const tampered = await run(dir, ['--verify', `${key.slice(0, -4)}ZZZZ`], noSecret);
  assert.notEqual(tampered.code, 0);
  assert.match(tampered.stdout, /"valid": false/);
});

test('the private signing key never appears in what is sent to a buyer', async (t) => {
  // The output is pasted into an email. The private half leaking there hands
  // every recipient the ability to mint their own keys — the exact failure the
  // move away from a shared secret was meant to remove.
  const dir = await scriptIn(t);
  await run(dir, ['--keygen'], { CITABLE_LICENSE_SECRET: '' });
  const priv = JSON.parse(await readFile(path.join(dir, 'license.private.json'), 'utf8'));

  const issued = await run(dir, ['buyer@example.com'], { CITABLE_LICENSE_SECRET: '' });
  assert.doesNotMatch(issued.stdout, new RegExp(priv.d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(issued.stderr, new RegExp(priv.d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const ledger = await readFile(path.join(dir, 'licenses.ndjson'), 'utf8');
  assert.doesNotMatch(ledger, new RegExp(priv.d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the files --keygen writes are actually ignored by git', async () => {
  // Every other guard in this file is about what the script prints or
  // appends. This one is about the file itself: `license.private.json` and
  // `licenses.ndjson` sit in the real working tree, not a sandbox, and if
  // either were ever committed the private signing key or a customer ledger
  // would be pushed to a public repository. Unlike most bugs this does not
  // announce itself — the business looks fine right up until someone notices
  // every Pro key can be forged, or a customer's email address turns up in
  // git history. `.gitignore` naming the file is not the same guarantee as
  // git actually ignoring it, so this checks the real mechanism rather than
  // grepping the ignore file's text.
  const { execFile } = await import('node:child_process');
  const check = (file) => new Promise((resolve) => {
    execFile('git', ['check-ignore', '-q', file], { cwd: ROOT }, (error) => resolve(error === null));
  });

  for (const file of ['license.private.json', 'licenses.ndjson', '.dev.vars', '.env']) {
    assert.equal(await check(file), true, `${file} must be ignored by git — check .gitignore`);
  }
});

test('--find re-derives a portable key identically', async (t) => {
  // Deterministic signing is why Ed25519 was chosen over ECDSA: re-issuing a
  // *different* key would leave the buyer's original still live.
  const dir = await scriptIn(t);
  await run(dir, ['--keygen'], { CITABLE_LICENSE_SECRET: '' });

  const issued = await run(dir, ['buyer@example.com', '--days', '365', '--seats', '2'], { CITABLE_LICENSE_SECRET: '' });
  const original = keyFrom(issued.stdout);
  assert.ok(original && original.startsWith('CTB2.'), `no portable key issued:\n${issued.stdout}`);

  const found = await run(dir, ['--find', 'buyer@example.com'], { CITABLE_LICENSE_SECRET: '' });
  assert.equal(found.code, 0, found.stderr);
  assert.equal(keyFrom(found.stdout), original, 're-derivation must return the identical key');
});
