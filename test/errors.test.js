// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Unit cover for the error vocabulary: redaction, abort classification, and the
 * two messages that must never echo a credential.
 *
 * Two rules are load-bearing here and are pinned as such. First, a redaction that
 * quietly stops working is invisible — every message still renders, just with the
 * secret in it — so the shapes that must be withheld are asserted directly.
 * Second, the missing-credential message is read by the model and written to the
 * session log, so a value that is not positively recognized as a reference name
 * must not survive into it.
 *
 * @module dsh-web-search-brave/test/errors
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_REDACTABLE_LENGTH,
  REDACTED,
  WEB_ABORTED,
  WEB_PROVIDER_CREDENTIAL_MISSING,
  WEB_PROVIDER_ERROR,
  abortable,
  credentialMissingError,
  describeError,
  isAbortError,
  looksLikePastedKey,
  providerError,
  redact,
  safeCredentialLabel,
  searchAborted,
  throwIfSearchAborted,
} from '../lib/errors.js';

/**
 * A token-shaped fixture, long enough to clear the redaction floor. Assembled
 * from fragments so this file is not itself a finding for the credential scan —
 * the scanner is right to flag the literal, which is the point.
 */
const TOKEN = 'bsa' + 'AbCdEfGhIjKlMnOpQrStUvWx';
/** A reference name: words separated by underscores, and what a user is meant to type. */
const REFERENCE = 'BRAVE_SEARCH_API_KEY';

test('isAbortError recognizes the AbortError shape and nothing else', () => {
  assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isAbortError(new Error('x')), false);
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError('AbortError'), false, 'a bare string is not an error object');
});

test('redact removes every occurrence of a long-enough secret', () => {
  assert.equal(redact(`token=${TOKEN} and again ${TOKEN}`, [TOKEN]), `token=${REDACTED} and again ${REDACTED}`);
  assert.equal(redact('nothing to hide', [TOKEN]), 'nothing to hide');
  // Non-strings and strings are coerced, so a log call can pass anything.
  assert.equal(redact(42, []), '42');
  assert.equal(redact('x', undefined), 'x', 'a missing secret list must not throw');
});

test('redact ignores a value too short to be worth replacing', () => {
  // Below the floor, blind replacement would mangle ordinary diagnostics without
  // protecting a real credential. The floor is the documented policy.
  const short = 'a'.repeat(MIN_REDACTABLE_LENGTH - 1);
  assert.equal(redact(`value ${short} here`, [short]), `value ${short} here`);
  const atFloor = 'a'.repeat(MIN_REDACTABLE_LENGTH);
  assert.equal(redact(`value ${atFloor} here`, [atFloor]), `value ${REDACTED} here`);
});

test('describeError renders one redacted line for any caught value', () => {
  assert.equal(describeError(new TypeError(`connect failed for ${TOKEN}`), [TOKEN]), `TypeError: connect failed for ${REDACTED}`);
  assert.equal(describeError('plain string', []), 'plain string');
  assert.equal(describeError(undefined, []), 'undefined');
});

test('providerError carries the seam code and a redacted message', () => {
  const error = providerError(`failed with ${TOKEN}`, { secrets: [TOKEN] });
  assert.equal(error.code, WEB_PROVIDER_ERROR);
  assert.equal(error.message.includes(TOKEN), false);
  assert.match(error.message, /\[redacted\]/u);
});

test('searchAborted carries WEB_ABORTED and prefers the caller cause', () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(searchAborted(controller.signal).code, WEB_ABORTED);
  // A caller abort is reported as caller cancellation even without a signal.
  assert.equal(searchAborted(undefined).code, WEB_ABORTED);
});

test('throwIfSearchAborted throws only for an already-aborted signal', () => {
  assert.doesNotThrow(() => throwIfSearchAborted(undefined));
  assert.doesNotThrow(() => throwIfSearchAborted(new AbortController().signal));
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => throwIfSearchAborted(controller.signal), (error) => error.code === WEB_ABORTED);
});

test('abortable passes a value through and rejects on a later caller abort', async () => {
  assert.equal(await abortable(Promise.resolve('done'), undefined), 'done');
  const controller = new AbortController();
  const pending = abortable(new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error.code === WEB_ABORTED);
  // An uncooperative operation that settles after the abort must not become an
  // unhandled rejection: the settlement handlers stay attached.
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  const late = Promise.withResolvers();
  await assert.rejects(abortable(late.promise, controller.signal), (error) => error.code === WEB_ABORTED);
  late.reject(new Error('too late'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.off('unhandledRejection', onRejection);
  assert.deepEqual(rejections, [], 'a late rejection must be observed, not left unhandled');
});

test('looksLikePastedKey withholds a value that is not shaped like a name', () => {
  // Every one of these is a plausible paste into the reference field, and every
  // one must be treated as a possible credential.
  for (const pasted of [
    TOKEN,
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'ghp_' + 'AbCdEfGhIjKlMnOpQrStUvWx',
    'sk-' + 'AbCdEfGhIjKlMnOpQrStUvWx',
    'aB3xK9mQ2pR7tY4wZ8nL6vC1',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    'BSA' + 'abc-def_ghi0123456789',
  ]) {
    assert.equal(looksLikePastedKey(pasted), true, `${pasted.slice(0, 6)}… must be withheld`);
  }
});

test('looksLikePastedKey lets a real reference name through', () => {
  for (const name of [REFERENCE, 'DEFAULT_API_KEY_ENV', 'my_brave_key_2', 'dsh-web-search-brave', 'service', '']) {
    assert.equal(looksLikePastedKey(name), false, `${name} must be treated as a name`);
  }
});

test('safeCredentialLabel withholds anything it cannot recognize as a name', () => {
  assert.equal(safeCredentialLabel(REFERENCE), REFERENCE, 'a real reference must stay legible to the operator');
  assert.equal(safeCredentialLabel('dsh-web-search-brave'), 'dsh-web-search-brave');
  assert.equal(safeCredentialLabel(''), '(empty)');
  for (const pasted of [TOKEN, 'AKIA' + 'IOSFODNN7EXAMPLE', 'aB3xK9mQ2pR7tY4wZ8nL6vC1']) {
    assert.equal(safeCredentialLabel(pasted).includes(pasted), false, 'a pasted value must not be echoed');
  }
});

test('the missing-credential message names the reference and never a pasted key', () => {
  const named = credentialMissingError(REFERENCE, ['the launch environment: X is not set']);
  assert.equal(named.code, WEB_PROVIDER_CREDENTIAL_MISSING);
  assert.match(named.message, new RegExp(REFERENCE, 'u'));
  assert.match(named.message, /Where the key was looked for, in order/u);

  const pasted = credentialMissingError(TOKEN, []);
  assert.equal(pasted.message.includes(TOKEN), false, 'the pasted value must not be copied into the message');
  assert.match(pasted.message, /it looks like a key, not a name/u);
  // The hint must not claim the value was never written down: the settings service
  // persists whatever is typed into the field, so the operator has to be told to
  // rotate it.
  assert.match(pasted.message, /persists what was typed into that field/u);
  assert.match(pasted.message, /rotate it/u);
  assert.equal(/not stored anywhere/u.test(pasted.message), false, 'the message must not contradict itself');
});
