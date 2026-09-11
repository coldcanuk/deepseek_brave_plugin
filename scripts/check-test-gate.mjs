// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Fail the test gate when the suite executes nothing.
 *
 * This check cannot live inside the suite: Node refuses to recurse, so a nested
 * `node --test` started from a test file is skipped with "node:test run() is
 * being called recursively". It therefore runs as its own command, after the
 * suite, and enforces the property the suite itself cannot observe: that the
 * runner actually executed tests.
 *
 * Why it is needed. `npm test` used to hand the runner a single quoted glob
 * pattern. Globs in the runner's `--test` argument were added in Node 21 while
 * `engines` declares `>=20`, so on Node 20 nothing matched and the command was
 * not a gate at all. The trap is that on modern Node a pattern matching no files
 * is a *vacuous success* — `tests 0` with exit code 0 — which is
 * indistinguishable from a green build. A floor on executed tests makes that case
 * loud.
 *
 * The runner is invoked through the same `node --test` discovery the `test`
 * script uses, so this also covers a future edit that reintroduces a
 * non-portable argument.
 *
 * @module dsh-web-search-brave/scripts/check-test-gate
 */
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Fewest tests that must execute for the gate to mean anything. The suite
 * carries 168 at the time of writing; the floor exists to catch a vacuous run,
 * not to track additions, so it sits well below the real count and does not
 * need editing every time a test is added.
 */
export const MINIMUM_EXPECTED_TESTS = 100;

/**
 * Count the tests a TAP run executed, by counting leaf `ok`/`not ok` result
 * lines. The plan line `1..N` is not used because it counts only top-level tests
 * on some versions.
 * @param tap - the runner's stdout.
 * @returns the number of executed test points.
 */
export function countTapTests(tap) {
  let count = 0;
  for (const line of tap.split('\n')) {
    if (/^(ok|not ok) \d+ - /u.test(line)) count += 1;
  }
  return count;
}

/**
 * Run the suite in a child process and report how many tests executed.
 * @returns the executed count, the failed count, the failing test names with
 *   their diagnostics, and the child's exit code.
 */
async function runSuite() {
  let stdout;
  let exitCode = 0;
  try {
    const result = await run(process.execPath, ['--test', '--test-reporter=tap'], {
      timeout: 600000,
      killSignal: 'SIGKILL',
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    stdout = String(result.stdout);
  } catch (error) {
    stdout = String(error.stdout ?? '');
    exitCode = typeof error.code === 'number' ? error.code : 1;
  }
  const lines = stdout.split('\n');
  return {
    executed: countTapTests(stdout),
    failed: lines.filter((line) => /^not ok \d+ - /u.test(line)).length,
    failures: failingTests(lines),
    exitCode,
  };
}

/** Longest diagnostic excerpt printed per failing test, so one runaway stack cannot bury the rest. */
const MAX_FAILURE_EXCERPT_LINES = 25;

/**
 * The failing tests and their diagnostics, extracted from a TAP stream.
 *
 * A gate that prints only a count leaves the failing test names inside the child
 * process's output, which is discarded — so a red CI job says "4 of 160 did not
 * pass" and nothing else, and the failure has to be reproduced locally to be
 * identified at all. Reporting the names and the `error:` bodies is the
 * difference between a gate and a hint.
 * @param lines - the runner's stdout, split into lines.
 * @returns one entry per failing test.
 */
export function failingTests(lines) {
  const failures = [];
  let current;
  let inDiagnostic = false;
  for (const line of lines) {
    const header = /^not ok \d+ - (.*)$/u.exec(line);
    if (header !== null) {
      current = { name: header[1].trim(), diagnostic: [] };
      failures.push(current);
      inDiagnostic = false;
      continue;
    }
    if (current === undefined) continue;
    if (/^\s*---$/u.test(line)) {
      inDiagnostic = true;
      continue;
    }
    if (/^\s*\.\.\.$/u.test(line)) {
      inDiagnostic = false;
      continue;
    }
    if (inDiagnostic && current.diagnostic.length < MAX_FAILURE_EXCERPT_LINES) current.diagnostic.push(line.trimEnd());
  }
  return failures.map((failure) => ({
    name: failure.name,
    diagnostic: failure.diagnostic.filter((line) => line.length > 0).join('\n'),
  }));
}

// Importing this module (as the suite does, to cover the failure parsing) must
// not run the gate: that would start a nested `node --test`, which Node refuses
// to run recursively and reports as a failed file. Only a direct invocation is
// the CLI.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { executed, failed, failures, exitCode } = await runSuite();

  if (executed < MINIMUM_EXPECTED_TESTS) {
    console.error(
      `check:test-gate FAILED: the suite executed ${executed} test(s), below the floor of ${MINIMUM_EXPECTED_TESTS}. ` +
        'A test command that runs nothing must never look like a pass.',
    );
    process.exit(1);
  }
  if (failed > 0 || exitCode !== 0) {
    console.error(`check:test-gate FAILED: ${failed} of ${executed} test(s) did not pass (runner exit ${exitCode}).`);
    for (const failure of failures) {
      console.error(`  FAIL ${failure.name}`);
      if (failure.diagnostic.length > 0) {
        for (const line of failure.diagnostic.split('\n')) console.error(`    ${line}`);
      }
    }
    process.exit(1);
  }
  console.log(`check:test-gate OK: ${executed} test(s) executed, none failed.`);
}
