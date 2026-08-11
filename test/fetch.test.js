/**
 * The SSRF guard.
 *
 * The hosted worker fetches any URL a stranger submits, so this guard is the
 * only thing standing between a public endpoint and internal address space.
 * Cloud metadata (169.254.169.254) is the target that matters most: reaching
 * it can yield instance credentials.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateHost, normalizeUrl } from '../src/core/fetch.js';

const blocked = (url) => {
  try {
    normalizeUrl(url);
    return false;
  } catch (error) {
    return error.code === 'private_host';
  }
};

test('blocks private and loopback hosts in dotted-quad form', () => {
  for (const host of [
    'http://127.0.0.1/',
    'http://localhost/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/',
    'http://box.local/',
    'http://metadata.google.internal/',
  ]) {
    assert.equal(blocked(host), true, `${host} should be blocked`);
  }
});

test('blocks alternate IPv4 encodings', () => {
  // These are normalised by the URL parser rather than by our patterns, so
  // pin the behaviour: a parser change must not silently open a hole.
  assert.equal(new URL('http://2130706433/').hostname, '127.0.0.1');
  for (const host of ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.0x0.0x0.0x1/', 'http://127.1/']) {
    assert.equal(blocked(host), true, `${host} should be blocked`);
  }
});

test('blocks IPv6 loopback, link-local and unique-local', () => {
  for (const host of ['http://[::1]/', 'http://[::]/', 'http://[fe80::1]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/']) {
    assert.equal(blocked(host), true, `${host} should be blocked`);
  }
});

test('blocks IPv4 addresses embedded in IPv6', () => {
  // The bypass this exists for: dotted-quad patterns never see
  // [::ffff:169.254.169.254], which routes straight to cloud metadata.
  for (const host of [
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[64:ff9b::169.254.169.254]/',
  ]) {
    assert.equal(blocked(host), true, `${host} should be blocked`);
  }
});

test('allows ordinary public hosts, including global IPv6', () => {
  for (const host of ['http://example.com/', 'https://sub.example.co.uk/path', 'http://[2606:4700::1111]/']) {
    assert.equal(blocked(host), false, `${host} should be allowed`);
  }
  // A global address whose low bits merely resemble a private IPv4 must not
  // be misread as embedding one.
  assert.equal(blocked('http://[2001:db8::a00:1]/'), false);
});

test('isPrivateHost tolerates malformed input without throwing', () => {
  for (const host of ['', null, undefined, '[', ':::::', '[::ffff:zzzz]', 'not a host']) {
    assert.equal(typeof isPrivateHost(host), 'boolean');
  }
});

test('allowPrivate opts out, for auditing a local dev server', () => {
  assert.doesNotThrow(() => normalizeUrl('http://localhost:3000/', { allowPrivate: true }));
  assert.doesNotThrow(() => normalizeUrl('http://[::ffff:127.0.0.1]/', { allowPrivate: true }));
});

test('a trailing dot does not smuggle a loopback host past the guard', () => {
  // "localhost." is the fully-qualified spelling of "localhost" and resolves
  // identically, so an anchored ^localhost$ test alone lets it straight through
  // to the hosted endpoint.
  for (const host of ['localhost.', 'LOCALHOST.', 'foo.internal.', 'x.local.']) {
    assert.equal(isPrivateHost(host), true, `${host} should be treated as private`);
  }
  assert.throws(() => normalizeUrl('http://localhost./'), /private or loopback/);
});

test('public hostnames that merely look private are still auditable', () => {
  // These are ordinary public domains. A prefix test like /^10\./ matches them
  // and makes the auditor refuse to look at a site that is perfectly fine.
  for (const host of ['10.example.com', '127.0.0.1.example.com', '192.168.example.com', 'localhost.example.com']) {
    assert.equal(isPrivateHost(host), false, `${host} is a public name and should be allowed`);
  }
  assert.doesNotThrow(() => normalizeUrl('https://10.example.com/'));
});

test('private IPv4 ranges are matched numerically, not by prefix', () => {
  for (const host of [
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '100.64.0.1', // carrier-grade NAT
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '224.0.0.1', // multicast
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} should be private`);
  }

  // Neighbouring public addresses must not be caught by the same rules.
  for (const host of ['11.0.0.1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '169.253.0.1', '8.8.8.8']) {
    assert.equal(isPrivateHost(host), false, `${host} is public`);
  }
});

test('alternate IPv4 spellings are canonicalised before the check', () => {
  // The URL parser rewrites these to dotted quads; the guard relies on that,
  // so it is worth pinning the behaviour rather than assuming it.
  for (const url of ['http://127.1/', 'http://0x7f000001/', 'http://2130706433/', 'http://0177.0.0.1/']) {
    assert.throws(() => normalizeUrl(url), /private or loopback/, `${url} should be refused`);
  }
});
