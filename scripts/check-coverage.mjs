#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Fail the build when coverage drops below the floors, on every supported Node.
 *
 * The runner's own threshold flags (`--test-coverage-lines` and friends) arrived
 * in Node 22, while `engines` allows Node 20 — where passing one is not a low
 * score but `node: bad option`, exit code 9. A gate that turns into an
 * invocation error on a supported runtime is worse than no gate, and skipping it
 * there would silently remove the check from half the matrix.
 *
 * So the thresholds are enforced here instead. On Node 22 and newer the runner
 * is asked to do it natively; on Node 20 the same floors are applied to the
 * report the runner does emit. Both paths print the same summary, and the exit
 * code means the same thing on either.
 *
 * The totals row is the one that matters: it is `all files`, and its name column
 * is stable, while the per-file rows above it are padded to the longest path.
 *
 * Run with `--report` for the same measurement without enforcement, which is what
 * `npm run test:coverage` does.
 *
 * @module dsh-web-search-brave/scripts/check-coverage
 */
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Coverage floors, in percent, over `lib/`. Set a few points under the current baseline. */
export const FLOORS = Object.freeze({ lines: 95, branches: 88, functions: 92 });

/** Whether the runner can enforce the floors itself. */
export const NATIVE_THRESHOLDS = Number.parseInt(process.versions.node, 10) >= 22;

/** Files coverage is measured over; the tests and scripts are not the product. */
const COVERAGE_INCLUDE = 'lib/**';

/**
 * The coverage flags the runner should be given.
 * @param enforce - whether the runner should apply the floors itself.
 * @returns the flag list for this Node version.
 */
export function coverageFlags(enforce = true) {
  // `--test-coverage-include` is Node 22+ as well, so on Node 20 the report covers
  // every executed file. The floor comparison reads the totals row, which both
  // versions report the same way.
  if (!NATIVE_THRESHOLDS) return [];
  const include = [`--test-coverage-include=${COVERAGE_INCLUDE}`];
  if (!enforce) return include;
  return [
    ...include,
    `--test-coverage-lines=${FLOORS.lines}`,
    `--test-coverage-branches=${FLOORS.branches}`,
    `--test-coverage-functions=${FLOORS.functions}`,
  ];
}

/**
 * Pull the totals row out of a coverage report.
 *
 * The runner writes `# ` on Node 20 and `ℹ ` on Node 22+, and aligns the columns
 * to the longest file path, so the parser strips the marker, finds the `all
 * files` row, and reads the three leading numbers rather than trusting column
 * offsets.
 * @param report - the runner's combined output.
 * @returns the totals, or `undefined` when the row is absent.
 */
export function parseTotals(report) {
  for (const rawLine of report.split('\n')) {
    const line = rawLine.replace(/^(?:#|ℹ)\s?/u, '');
    if (!line.startsWith('all files')) continue;
    const numbers = line.match(/\d+(?:\.\d+)?/gu);
    if (numbers === null || numbers.length < 3) continue;
    return { lines: Number(numbers[0]), branches: Number(numbers[1]), functions: Number(numbers[2]) };
  }
  return undefined;
}

/**
 * Every floor this total misses.
 * @param totals - the measured percentages.
 * @returns one message per miss.
 */
export function shortfalls(totals) {
  const problems = [];
  if (totals.lines < FLOORS.lines) problems.push(`lines ${totals.lines}% is below the ${FLOORS.lines}% floor`);
  if (totals.branches < FLOORS.branches) problems.push(`branches ${totals.branches}% is below the ${FLOORS.branches}% floor`);
  if (totals.functions < FLOORS.functions) problems.push(`functions ${totals.functions}% is below the ${FLOORS.functions}% floor`);
  return problems;
}

/**
 * Run the suite with coverage.
 * @param enforce - whether the runner should apply the floors itself.
 * @returns the runner's combined output and its exit code.
 */
async function runCoverage(enforce) {
  try {
    const result = await run(process.execPath, ['--test', '--experimental-test-coverage', ...coverageFlags(enforce)], {
      timeout: 600000,
      killSignal: 'SIGKILL',
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    return { output: `${result.stdout}${result.stderr}`, exitCode: 0 };
  } catch (error) {
    return { output: `${error.stdout ?? ''}${error.stderr ?? ''}`, exitCode: typeof error.code === 'number' ? error.code : 1 };
  }
}

// Importing this module (as the suite does, to cover the floor comparison and the
// totals parsing) must not run the suite. Only a direct invocation is the CLI.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reportOnly = process.argv.includes('--report');
  const { output, exitCode } = await runCoverage(!reportOnly);
  const totals = parseTotals(output);
  process.stdout.write(output);

  if (totals === undefined) {
    // No totals row means the run never produced a report — a failed suite, a bad
    // flag, or a crash. Either way this is not a pass, and the runner's exit code
    // is reported with it so the cause is visible.
    process.stderr.write(`check:coverage FAILED: no coverage totals were reported (runner exit ${exitCode}).\n`);
    process.exit(1);
  }

  if (reportOnly) {
    process.stdout.write(`coverage: lines ${totals.lines}%, branches ${totals.branches}%, functions ${totals.functions}%.\n`);
    process.exit(exitCode === 0 ? 0 : 1);
  }

  const problems = shortfalls(totals);
  if (problems.length > 0) {
    process.stderr.write(`check:coverage FAILED: ${problems.join('; ')}.\n`);
    process.exit(1);
  }
  if (exitCode !== 0) {
    // The runner enforces the thresholds natively on Node 22+, so a non-zero exit
    // with totals above the floors is a failing test rather than a coverage miss.
    process.stderr.write(`check:coverage FAILED: the suite did not pass (runner exit ${exitCode}).\n`);
    process.exit(1);
  }
  process.stdout.write(`check:coverage OK: lines ${totals.lines}%, branches ${totals.branches}%, functions ${totals.functions}% of ${COVERAGE_INCLUDE}.\n`);
}
