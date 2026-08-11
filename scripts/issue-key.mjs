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
 *   CITABLE_LICENSE_SECRET=... node scripts/issue-key.mjs --verify CTB1....
 *
 * The same secret must be set as the LICENSE_SECRET Worker secret, or keys
 * will not validate in the hosted app.
 */

import process from 'node:process';
import { appendFile, readFile } from 'node:fs/promises';
import { issueKey, verifyKey } from '../src/core/license.js';

const LEDGER = new URL('../licenses.ndjson', import.meta.url);

function usage(message) {
  if (message) process.stderr.write(`issue-key: ${message}\n\n`);
  process.stderr.write(`Usage:
  issue-key <email> [--days N] [--plan pro] [--seats N]
  issue-key --verify <key>
  issue-key --list

  --days 0   lifetime key (default; matches a one-time purchase)
  --days 365 annual key, expires after a year

Requires CITABLE_LICENSE_SECRET in the environment.
`);
  process.exit(message ? 2 : 0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help')) usage();

  const secret = process.env.CITABLE_LICENSE_SECRET;
  if (!secret) usage('set CITABLE_LICENSE_SECRET first (32+ random characters)');
  if (secret.length < 24) usage('CITABLE_LICENSE_SECRET is too short — use at least 24 characters');

  if (argv[0] === '--list') {
    try {
      process.stdout.write(await readFile(LEDGER, 'utf8'));
    } catch {
      process.stdout.write('No keys issued yet.\n');
    }
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

  const { key, payload } = await issueKey({ email, plan, days, seats, secret });

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
