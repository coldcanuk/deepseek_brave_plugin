// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Cover for the portable coverage gate.
 *
 * The gate exists because the runner's threshold flags are Node 22+ while
 * `engines` allows Node 20, and a gate that dies on `bad option` on a supported
 * runtime is worse than no gate. What has to hold on every version is that the
 * totals are read correctly from either report format and compared against the
 * same floors, so both halves are covered here directly.
 *
 * @module dsh-web-search-brave/test/check-coverage
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FLOORS, NATIVE_THRESHOLDS, coverageFlags, parseTotals, shortfalls } from '../scripts/check-coverage.mjs';

/** A totals row as Node 22+ writes it: `ℹ ` marker, columns padded to the longest path. */
const MODERN = [
  'ℹ start of coverage report',
  'ℹ ------------------------------------------------------------------',
  'ℹ file              | line % | branch % | funcs % | uncovered lines',
  'ℹ ------------------------------------------------------------------',
  'ℹ lib               |        |          |         | ',
  'ℹ  client.js        |  98.55 |    93.48 |  100.00 | 320-321',
  'ℹ  errors.js        |  99.15 |   100.00 |   88.89 | 230-231',
  'ℹ ------------------------------------------------------------------',
  'ℹ all files         |  99.13 |    94.21 |   96.84 | ',
  'ℹ ------------------------------------------------------------------',
  'ℹ end of coverage report',
].join('\n');

/** The same report as Node 20 writes it: `# ` marker, and no include flag. */
const LEGACY = [
  '# start of coverage report',
  '# ------------------------------------------------------------------',
  '# file              | line % | branch % | funcs % | uncovered lines',
  '# all files         |  97.79 |    94.26 |   94.61 | ',
  '# ------------------------------------------------------------------',
  '# end of coverage report',
].join('\n');

test('parseTotals reads the totals row out of either report format', () => {
  assert.deepEqual(parseTotals(MODERN), { lines: 99.13, branches: 94.21, functions: 96.84 });
  assert.deepEqual(parseTotals(LEGACY), { lines: 97.79, branches: 94.26, functions: 94.61 });
});

test('parseTotals reports nothing when the run produced no report', () => {
  // A crashed suite, a bad flag, or a process killed by the timeout. Returning
  // `undefined` is what makes the CLI fail loudly instead of passing on silence.
  assert.equal(parseTotals(''), undefined);
  assert.equal(parseTotals('node: bad option: --test-coverage-lines=95'), undefined);
  assert.equal(parseTotals('# all files | 99 | 99 |'), undefined, 'a truncated row is not a measurement');
});

test('shortfalls names every floor a total misses', () => {
  assert.deepEqual(shortfalls({ lines: 95, branches: 88, functions: 92 }), [], 'the floors themselves pass');
  const problems = shortfalls({ lines: 94.99, branches: 87.99, functions: 91.99 });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /lines 94\.99% is below the 95% floor/u);
  assert.match(problems[1], /branches 87\.99% is below the 88% floor/u);
  assert.match(problems[2], /functions 91\.99% is below the 92% floor/u);
});

test('shortfalls measures against the exported floors, not a second copy of them', () => {
  const atFloor = { lines: FLOORS.lines, branches: FLOORS.branches, functions: FLOORS.functions };
  assert.deepEqual(shortfalls(atFloor), []);
  assert.equal(shortfalls({ ...atFloor, lines: FLOORS.lines - 0.01 }).length, 1);
});

test('coverageFlags never passes an unsupported flag to the runner', () => {
  const flags = coverageFlags(true);
  if (NATIVE_THRESHOLDS) {
    // The thresholds are the runner's job on Node 22+, and it must be told them.
    assert.deepEqual(flags, [
      '--test-coverage-include=lib/**',
      `--test-coverage-lines=${FLOORS.lines}`,
      `--test-coverage-branches=${FLOORS.branches}`,
      `--test-coverage-functions=${FLOORS.functions}`,
    ]);
  } else {
    // On Node 20 those options are `bad option`, exit code 9 — and so is the
    // include flag, which arrived with them.
    assert.deepEqual(flags, []);
  }
});

test('coverageFlags drops only the thresholds in report mode', () => {
  const flags = coverageFlags(false);
  assert.equal(flags.some((flag) => flag.startsWith('--test-coverage-lines')), false);
  assert.equal(flags.some((flag) => flag.startsWith('--test-coverage-branches')), false);
  assert.equal(flags.some((flag) => flag.startsWith('--test-coverage-functions')), false);
});

test('the gate is invoked the same way on every supported Node', async () => {
  // The end-to-end run belongs to CI, which already executes it on Node 20, 22,
  // and 24 — the exact combination whose failure this gate exists to prevent.
  // What is asserted here is the contract the CLI must satisfy: it is importable
  // without running the suite, and it accepts `--report` for measurement without
  // enforcement. Running the whole suite from inside the suite would be slow,
  // recursive, and would prove less than the matrix does.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const script = new URL('../scripts/check-coverage.mjs', import.meta.url).pathname;
  const { stdout } = await promisify(execFile)(process.execPath, ['--check', script], { timeout: 60000 });
  assert.equal(stdout, '', 'a syntax check produces no output');
  assert.equal(typeof coverageFlags, 'function');
});
