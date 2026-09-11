// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Cover for the credential scan behind `npm run check:secrets`.
 *
 * The scanner is a security control, so its own false-negative behavior needs
 * pinning. It silently stopped matching two of its seven patterns once: the
 * whitespace classes in the "assignment" patterns had been written as a literal
 * `s` (a lost escape), so `x-subscription-token = "..."` and
 * `apiKey = "..."` were no longer findings. Every probe below is a line that
 * *must* be caught, or a look-alike that must *not* be, so the same drift fails
 * loudly here instead of in a leaked commit.
 *
 * The probe strings are assembled from fragments rather than written whole: the
 * literals would otherwise be findings in this very file, and the scanner is
 * correct to flag them.
 *
 * @module dsh-web-search-brave/test/check-secrets
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PATTERNS, scanText } from '../scripts/check-secrets.mjs';

/** A Brave-shaped value long enough to clear every pattern's length floor. */
const TOKEN = 'bsa' + 'AbCdEfGhIjKlMnOpQrStUvWx';
/** An obvious high-entropy filler, never a usable credential. */
const FILLER = 'abcdefghijklmnopqrstuvwx';
/** The header name, split so this file is not itself an assignment finding. */
const HEADER = 'x-subscription-token';

/**
 * Every pattern name that matches a line.
 * @param line - the probe line.
 * @returns the matched pattern names.
 */
function matches(line) {
  return PATTERNS.filter(({ pattern }) => pattern.test(line)).map(({ name }) => name);
}

/** Assert a line is reported as a finding. */
function expectFinding(line) {
  assert.notDeepEqual(matches(line), [], `expected a finding for: ${line}`);
}

/** Assert a line is not reported. */
function expectClean(line) {
  assert.deepEqual(matches(line), [], `expected no finding for: ${line}`);
}

test('the scanner still has its full pattern set', () => {
  // A pattern removed in a refactor is a silent hole; the count keeps that loud.
  assert.equal(PATTERNS.length, 7);
  for (const { name, pattern } of PATTERNS) {
    assert.ok(pattern instanceof RegExp, `${name} must be a RegExp`);
    assert.equal(pattern.flags.includes('g'), false, `${name} must not carry /g: test() would go stateful`);
  }
});

test('an assignment of a literal token is a finding in every spelling', () => {
  expectFinding(`${HEADER} = "${TOKEN}"`);
  expectFinding(`"${HEADER}": "${TOKEN}"`);
  expectFinding(`${HEADER}='${TOKEN}'`);
  expectFinding(`headers['${HEADER}'] = '${TOKEN}'`);
  expectFinding(`apiKey = "${FILLER}"`);
  expectFinding(`API_KEY: "${FILLER}"`);
  expectFinding(`api_key="${FILLER}"`);
  expectFinding(`api-key: '${FILLER}'`);
});

test('a token value is a finding even when no name precedes it', () => {
  expectFinding(`const leaked = '${TOKEN}';`);
  expectFinding(`Authorization: Bearer ${TOKEN}`);
});

test('the other credential shapes are all still detected', () => {
  expectFinding('AKIA' + 'ABCDEFGHIJKLMNOP');
  expectFinding('ghp_' + 'AbCdEfGhIjKlMnOpQrStUvWx');
  expectFinding('sk-' + 'AbCdEfGhIjKlMnOpQrStUvWx');
  expectFinding('-----BEGIN ' + 'RSA PRIVATE KEY-----');
});

test('credential references and short placeholders are not findings', () => {
  // The plugin's whole credential model is reference-based: these name a
  // credential, they never hold one, and flagging them would train operators to
  // ignore the scanner.
  expectClean('headers[SUBSCRIPTION_TOKEN_HEADER] = apiKey;');
  expectClean('apiKeyEnv: DEFAULT_API_KEY_ENV,');
  expectClean(`const ${HEADER} = 'the header name';`);
  expectClean('// the apiKey setting names a credential, never holds one');
  expectClean('apiKey: "short",');
  expectClean(`BRAVE_SEARCH_API_KEY=""`);
});

test('scanText reports the file, the 1-based line, and the pattern name only', () => {
  const findings = [];
  scanText(`line one is fine\napiKey = "${FILLER}"\n`, 'fixture.js', findings);
  assert.deepEqual(findings, [{ file: 'fixture.js', line: 2, name: 'quoted api-key assignment' }]);
});

test('the scanner exits non-zero and never prints the matched text', () => {
  // The end-to-end contract: findings fail the build, and a scanner that echoes
  // a secret writes it into the CI log it exists to protect.
  const script = fileURLToPath(new URL('../scripts/check-secrets.mjs', import.meta.url));
  let status = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  } catch (error) {
    status = error.status ?? -1;
    stdout = String(error.stdout ?? '');
    stderr = String(error.stderr ?? '');
  }
  assert.equal(status, 0, `check-secrets must pass on this repository; stderr: ${stderr}`);
  assert.match(stdout, /check-secrets: clean/u);
  assert.match(stdout, new RegExp(`\\b${PATTERNS.length} patterns`, 'u'));
});

test('the test gate reports which tests failed, not only how many', async () => {
  // A gate that prints a bare count hides the failing names inside a child
  // process whose output is discarded, so a red CI job has to be reproduced
  // locally before it can even be named. This is the parsing behind the fix.
  const { failingTests } = await import('../scripts/check-test-gate.mjs');
  const tap = [
    'ok 1 - a passing test',
    'not ok 2 - a failing test',
    '  ---',
    "  error: 'Expected values to be strictly deep-equal:'",
    '  code: ERR_ASSERTION',
    '  ...',
    'ok 3 - another passing test',
    'not ok 4 - a second failing test',
    '  ---',
    '  error: |-',
    '    boom',
    '  ...',
  ].join('\n');
  assert.deepEqual(failingTests(tap.split('\n')), [
    { name: 'a failing test', diagnostic: "  error: 'Expected values to be strictly deep-equal:'\n  code: ERR_ASSERTION" },
    { name: 'a second failing test', diagnostic: '  error: |-\n    boom' },
  ]);
  assert.deepEqual(failingTests(['ok 1 - fine']), []);
});
