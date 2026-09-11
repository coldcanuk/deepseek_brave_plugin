// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Secret-manager lookups: the exact commands issued, the first-line extraction,
 * every "no value" outcome, and the guarantee that nothing but the value itself
 * ever leaves the lookup.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_GNOME_KEYRING_ATTRIBUTES,
  DEFAULT_PASS_PATH,
  GNOME_SECRET_TOOL,
  PASS_TOOL,
  SECRET_LOOKUP_TIMEOUT_MS,
  firstLine,
  lookupGnomeKeyring,
  lookupPass,
  resolveSecret,
  secretAttributes,
} from '../lib/secrets.js';
import { missingToolExecFile, scriptedExecFile } from './helpers/fake-secret-tools.js';

/** The value a scripted secret manager returns; an obvious fixture. */
const STORED_KEY = 'brave-fixture-value-from-password-manager';

test('firstLine returns the first non-blank, trimmed line', () => {
  assert.equal(firstLine('value\n'), 'value');
  assert.equal(firstLine('\n\n  value  \nsecond\n'), 'value');
  assert.equal(firstLine('secret\nusername: name\n'), 'secret');
  assert.equal(firstLine(''), undefined);
  assert.equal(firstLine('   \n\t\n'), undefined);
  assert.equal(firstLine(undefined), undefined);
  assert.equal(firstLine(42), undefined);
});

test('secretAttributes drops unusable pairs and bounds the list', () => {
  assert.deepEqual(secretAttributes({ service: 'a', account: 'b' }), [['service', 'a'], ['account', 'b']]);
  assert.deepEqual(secretAttributes({ '--flag': 'x', good: 'y' }), [['good', 'y']]);
  assert.deepEqual(secretAttributes({ service: '-dash' }), []);
  assert.deepEqual(secretAttributes({ service: '' }), []);
  assert.deepEqual(secretAttributes({ service: 42 }), []);
  assert.deepEqual(secretAttributes(null), []);
  assert.deepEqual(secretAttributes(['a', 'b']), []);
  assert.equal(secretAttributes(Object.fromEntries(Array.from({ length: 40 }, (_entry, index) => ['k' + index, 'v']))).length, 16);
});

test('lookupGnomeKeyring issues the documented secret-tool command', async () => {
  const execFile = scriptedExecFile({ 'secret-tool lookup service dsh-web-search-brave': STORED_KEY + '\n' });
  const result = await lookupGnomeKeyring(DEFAULT_GNOME_KEYRING_ATTRIBUTES, { execFile });
  assert.equal(result.value, STORED_KEY);
  assert.equal(result.source, 'gnome-keyring');
  // The declared hit type carries `attempted`, so a direct hit must include it as
  // an empty list rather than omitting the field: a consumer reading it must not
  // have to distinguish "nothing was tried first" from "the field is missing".
  assert.deepEqual(result.attempted, []);
  assert.deepEqual(execFile.calls, [{ file: 'secret-tool', args: ['lookup', 'service', 'dsh-web-search-brave'] }]);
});

test('lookupGnomeKeyring preserves multi-attribute order', async () => {
  const execFile = scriptedExecFile({ 'secret-tool lookup xdg:schema org.gnome.keyring.Note Title Brave Search API Paid': STORED_KEY });
  const result = await lookupGnomeKeyring({ 'xdg:schema': 'org.gnome.keyring.Note', Title: 'Brave Search API Paid' }, { execFile });
  assert.equal(result.value, STORED_KEY);
  assert.deepEqual(execFile.calls[0].args, ['lookup', 'xdg:schema', 'org.gnome.keyring.Note', 'Title', 'Brave Search API Paid']);
});

test('lookupPass issues the documented pass command and takes the first line', async () => {
  const execFile = scriptedExecFile({ 'pass show dsh/brave-search-api': STORED_KEY + '\nusername: chuck\nmore notes\n' });
  const result = await lookupPass(DEFAULT_PASS_PATH, { execFile });
  assert.equal(result.value, STORED_KEY);
  assert.equal(result.source, 'pass');
  assert.deepEqual(result.attempted, [], 'a direct hit reports an empty note list, not a missing field');
  assert.deepEqual(execFile.calls, [{ file: 'pass', args: ['show', 'dsh/brave-search-api'] }]);
});

test('an absent tool, an unmatched item, an empty entry, and a timeout all yield a note', async () => {
  const missing = await lookupGnomeKeyring(DEFAULT_GNOME_KEYRING_ATTRIBUTES, { execFile: missingToolExecFile() });
  assert.equal(missing.value, undefined);
  assert.match(missing.attempted.join(' '), /secret-tool is not installed/u);

  const unmatched = await lookupGnomeKeyring(DEFAULT_GNOME_KEYRING_ATTRIBUTES, { execFile: scriptedExecFile({ 'secret-tool lookup service dsh-web-search-brave': { exit: 1 } }) });
  assert.equal(unmatched.value, undefined);
  assert.match(unmatched.attempted.join(' '), /secret-tool has no matching entry/u);

  const empty = await lookupPass(DEFAULT_PASS_PATH, { execFile: scriptedExecFile({ 'pass show dsh/brave-search-api': '   \n' }) });
  assert.equal(empty.value, undefined);
  assert.match(empty.attempted.join(' '), /the entry is empty/u);

  const killed = new Error('killed');
  killed.killed = true;
  const timedOut = await lookupPass(DEFAULT_PASS_PATH, { execFile: scriptedExecFile({ 'pass show dsh/brave-search-api': { error: killed } }) });
  assert.match(timedOut.attempted.join(' '), new RegExp('did not answer within ' + SECRET_LOOKUP_TIMEOUT_MS + ' ms', 'u'));

  const aborted = new Error('aborted');
  aborted.name = 'AbortError';
  const cancelled = await lookupGnomeKeyring(DEFAULT_GNOME_KEYRING_ATTRIBUTES, { execFile: scriptedExecFile({ 'secret-tool lookup service dsh-web-search-brave': { error: aborted } }) });
  assert.match(cancelled.attempted.join(' '), /was cancelled/u);
});

test('a lookup with no configured attributes or entry path never runs a command', async () => {
  const gnome = await lookupGnomeKeyring({}, { execFile: missingToolExecFile() });
  assert.match(gnome.attempted.join(' '), /no lookup attributes are configured/u);
  const pass = await lookupPass('   ', { execFile: missingToolExecFile() });
  assert.match(pass.attempted.join(' '), /no entry path is configured/u);
});

test('an attempt note names the attributes but never their values', async () => {
  const result = await lookupGnomeKeyring({ service: 'the-value-that-must-not-be-echoed' }, { execFile: scriptedExecFile({}) });
  const notes = result.attempted.join(' ');
  assert.match(notes, /attributes: service/u);
  assert.equal(notes.includes('the-value-that-must-not-be-echoed'), false);
});

test('resolveSecret with secretManager none runs nothing at all', async () => {
  const execFile = missingToolExecFile();
  const result = await resolveSecret({ manager: 'none', execFile, gnomeKeyringAttributes: DEFAULT_GNOME_KEYRING_ATTRIBUTES, passPath: DEFAULT_PASS_PATH });
  assert.deepEqual(result, { attempted: [] });
  assert.deepEqual(execFile.calls, []);
});

test('auto tries the keyring first and stops when it finds the key', async () => {
  const execFile = scriptedExecFile({ 'secret-tool lookup service dsh-web-search-brave': STORED_KEY });
  const result = await resolveSecret({ manager: 'auto', execFile, gnomeKeyringAttributes: DEFAULT_GNOME_KEYRING_ATTRIBUTES, passPath: DEFAULT_PASS_PATH });
  assert.equal(result.value, STORED_KEY);
  assert.equal(result.source, 'gnome-keyring');
  assert.deepEqual(result.attempted, []);
  assert.deepEqual(execFile.calls.map((call) => call.file), [GNOME_SECRET_TOOL]);
});

test('auto falls through to pass when the keyring has nothing', async () => {
  const execFile = scriptedExecFile({ 'pass show dsh/brave-search-api': STORED_KEY });
  const result = await resolveSecret({ manager: 'auto', execFile, gnomeKeyringAttributes: DEFAULT_GNOME_KEYRING_ATTRIBUTES, passPath: DEFAULT_PASS_PATH });
  assert.equal(result.value, STORED_KEY);
  assert.equal(result.source, 'pass');
  assert.equal(result.attempted.length, 1);
  assert.deepEqual(execFile.calls.map((call) => call.file), [GNOME_SECRET_TOOL, PASS_TOOL]);
});

test('an explicit manager consults only that manager', async () => {
  const gnomeOnly = scriptedExecFile({});
  await resolveSecret({ manager: 'gnome-keyring', execFile: gnomeOnly, gnomeKeyringAttributes: DEFAULT_GNOME_KEYRING_ATTRIBUTES, passPath: PASS_TOOL });
  assert.deepEqual(gnomeOnly.calls.map((call) => call.file), [GNOME_SECRET_TOOL]);

  const passOnly = scriptedExecFile({ 'pass show dsh/brave-search-api': STORED_KEY });
  const result = await resolveSecret({ manager: 'pass', execFile: passOnly, gnomeKeyringAttributes: DEFAULT_GNOME_KEYRING_ATTRIBUTES, passPath: DEFAULT_PASS_PATH });
  assert.equal(result.value, STORED_KEY);
  assert.deepEqual(passOnly.calls.map((call) => call.file), [PASS_TOOL]);
});

test('an unrecognized manager behaves as auto rather than failing', async () => {
  const execFile = scriptedExecFile({ 'pass show dsh/brave-search-api': STORED_KEY });
  const result = await resolveSecret({ manager: 'keychain', execFile, gnomeKeyringAttributes: DEFAULT_GNOME_KEYRING_ATTRIBUTES, passPath: DEFAULT_PASS_PATH });
  assert.equal(result.value, STORED_KEY);
});

test('no attempt note can carry the secret', async () => {
  const execFile = scriptedExecFile({ 'secret-tool lookup service dsh-web-search-brave': { error: Object.assign(new Error('failed after printing ' + STORED_KEY), { stderr: STORED_KEY }) } });
  const result = await resolveSecret({ manager: 'auto', execFile, gnomeKeyringAttributes: DEFAULT_GNOME_KEYRING_ATTRIBUTES, passPath: DEFAULT_PASS_PATH });
  assert.equal(JSON.stringify(result).includes(STORED_KEY), false);
});
