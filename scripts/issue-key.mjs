#!/usr/bin/env node
/**
 * Issue a Pro license key after a sale.
 *
 * Run this once per purchase and email the key to the buyer. It is deliberately
 * manual: at low volume a human in the loop costs nothing and catches fraud,
 * and it means the product needs no webhook endpoint, no database and no
 * payment-provider integration to start taking money.
 *
 *   CITABLE_LICENSE_SECRET=... node scripts/issue-key.mjs buyer@example.com
 *   CITABLE_LICENSE_SECRET=... node scripts/issue-key.mjs buyer@example.com --days 365
 *   CITABLE_LICENSE_SECRET=... node scripts/issue-key.mjs --verify CTB1...
 *   CITABLE_LICENSE_SECRET=... node scripts/issue-key.mjs --find buyer@example.com
 *
 * The same secret must be set as the LICENSE_SECRET Worker secret, or keys
 * will not validate in the hosted app.
 */

import process from 'node:process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { generateSigningPair, issueKey, keyFromPayload, verifyKey } from '../src/core/license.js';

const LEDGER = new URL('../licenses.ndjson', import.meta.url);
const PRIVATE_KEY_FILE = new URL('../license.private.json', import.meta.url);

/**
 * The Ed25519 private half, if a pair has been generated.
 *
 * Keys signed with this verify against the public constant compiled into the
 * package, which means a buyer needs nothing but the key itself. The old HMAC
 * path only worked where the signing secret was also present, so a buyer who
 * followed the emailed instructions silently got the free tier.
 */
async function loadPrivateKey() {
  const fromEnv = process.env.CITABLE_LICENSE_KEY;
  if (fromEnv) {
    try {
      return JSON.parse(fromEnv);
    } catch {
      usage('CITABLE_LICENSE_KEY is set but is not valid JSON (expected an Ed25519 JWK)');
    }
  }
  try {
    return JSON.parse(await readFile(PRIVATE_KEY_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function usage(message) {
  if (message) process.stderr.write(`issue-key: ${message}\n\n`);
  process.stderr.write(`Usage:
  issue-key <email> [--days N] [--plan pro] [--seats N]
  issue-key --verify <key>
  issue-key --find <email>    re-derive the key already sold to this buyer
  issue-key --list
  issue-key --keygen          create the signing pair (run once, first)

  --days 0   lifetime key (default; matches a one-time purchase)
  --days 365 annual key, expires after a year

Signing uses license.private.json (or CITABLE_LICENSE_KEY). Run --keygen once
to create it. CITABLE_LICENSE_SECRET still signs legacy CTB1 keys, which only
verify where that same secret is configured — the hosted Worker, not a buyer's
machine.
`);
  process.exit(message ? 2 : 0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help')) usage();

  if (argv[0] === '--keygen') {
    const { privateKey, publicX } = await generateSigningPair();
    await writeFile(PRIVATE_KEY_FILE, `${JSON.stringify(privateKey, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`
Signing pair created.
${'-'.repeat(66)}
Private half written to license.private.json (gitignored, mode 600).
Losing it means every future key must be re-issued under a new pair; leaking
it means anyone can mint Pro keys. Back it up somewhere you would keep a
password.

Paste this line into src/core/license.js, replacing the empty value, then
commit it — the public half is meant to ship:

export const LICENSE_PUBLIC_KEY = '${publicX}';

${'-'.repeat(66)}
`);
    return;
  }

  const privateKey = await loadPrivateKey();
  const secret = process.env.CITABLE_LICENSE_SECRET;
  if (!privateKey && !secret) {
    usage('no signing key — run `node scripts/issue-key.mjs --keygen` first');
  }
  if (!privateKey && secret && secret.length < 24) {
    usage('CITABLE_LICENSE_SECRET is too short — use at least 24 characters');
  }

  if (argv[0] === '--list') {
    try {
      process.stdout.write(await readFile(LEDGER, 'utf8'));
    } catch {
      process.stdout.write('No keys issued yet.\n');
    }
    return;
  }

  if (argv[0] === '--find') {
    const needle = String(argv[1] || '').toLowerCase().trim();
    if (!needle) usage('--find needs an email address');

    let ledger;
    try {
      ledger = await readFile(LEDGER, 'utf8');
    } catch {
      process.stderr.write('issue-key: no licenses.ndjson yet — nothing has been issued.\n');
      process.exit(1);
    }

    const matches = ledger
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && String(entry.e || '').toLowerCase().includes(needle));

    if (!matches.length) {
      process.stderr.write(`issue-key: no key on record for ${needle}\n`);
      process.exit(1);
    }

    for (const entry of matches) {
      // Signing is deterministic, so this returns the key they were sent
      // rather than minting a second one for the same purchase.
      const { i, e, p, s: seats, x, issuedAt } = entry;
      const key = await keyFromPayload({ v: entry.v, i, e, p, s: seats, t: entry.t, x }, { secret, privateKey });
      const status = x === 0 ? 'lifetime' : x * 1000 < Date.now() ? `EXPIRED ${new Date(x * 1000).toISOString().slice(0, 10)}` : `expires ${new Date(x * 1000).toISOString().slice(0, 10)}`;
      process.stdout.write(`\n${e}  ·  ${p}  ·  ${seats} seat(s)  ·  ${status}\n`);
      process.stdout.write(`issued ${issuedAt || 'unknown'}  ·  id ${i}\n`);
      process.stdout.write(`${key}\n`);
    }
    process.stdout.write('\n');
    return;
  }

  if (argv[0] === '--verify') {
    const result = await verifyKey(argv[1], secret);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.valid ? 0 : 1);
  }

  const email = argv[0];
  if (!email.includes('@')) usage(`"${email}" does not look like an email address`);

  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };

  const days = Number.parseInt(flag('days', '0'), 10);
  if (!Number.isFinite(days)) usage('--days must be a number');
  const plan = flag('plan', 'pro');
  const seats = Number.parseInt(flag('seats', '1'), 10) || 1;

  const { key, payload } = await issueKey({ email, plan, days, seats, secret, privateKey });

  // The ledger is the record of what was sold — needed to honour refunds and
  // to populate REVOKED_KEY_IDS if a key leaks.
  await appendFile(LEDGER, `${JSON.stringify({ ...payload, issuedAt: new Date().toISOString() })}\n`, 'utf8');

  process.stdout.write(`
Key issued for ${email}
${'-'.repeat(60)}
${key}
${'-'.repeat(60)}
Plan: ${plan} · Seats: ${seats} · ${days === 0 ? 'Lifetime' : `Expires in ${days} days`}
Key id: ${payload.i}   (add to REVOKED_KEY_IDS to revoke)
Logged to licenses.ndjson — keep that file out of git.

Send the buyer:

  Your Citable Pro key:

    ${key}

  Web:  paste it into the "Pro key" field at your Citable URL.
  CLI:  export CITABLE_KEY="${key}"
        npx citable yoursite.com --site --markdown --out audit.md

`);
}

main().catch((error) => {
  process.stderr.write(`issue-key: ${(error && error.message) || error}\n`);
  process.exit(1);
});
