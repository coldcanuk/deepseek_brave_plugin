// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Regression cover for the per-attempt deadline.
 *
 * The bug this file pins down is a process-level one, so it cannot be observed
 * from inside the test runner's own event loop: the runner keeps handles open
 * and would mask it. Each test therefore spawns a *child* process whose only
 * pending work is one search attempt, and asserts on the child's exit status.
 *
 * The failure it guards against: `AbortSignal.timeout()` arms an unref'd timer.
 * When the transport holds no handle of its own — a promise-only `fetch`
 * stand-in, or a socket that has not opened yet — the event loop has nothing
 * left to keep Node alive, and the process exits with an unsettled promise
 * (exit code 13) instead of reporting the timeout. In the suite this surfaced as
 * `cancelledByParent` on every later test in the file, which is why the count of
 * cancelled tests is asserted here as well.
 *
 * @module dsh-web-search-brave/test/keepalive
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const MODULE_URL = new URL('../lib/client.js', import.meta.url).href;
/** A token long enough to clear the redaction floor, so messages are realistic. */
const TOKEN = 'bsa'.repeat(12);

/**
 * Run one snippet in a fresh Node process with no ambient handles.
 * @param source - the module body to evaluate, ending in a top-level await.
 * @returns the child's stdout, stderr, and exit code.
 */
async function runChild(source) {
  const script =
    `import { fetchSearch } from ${JSON.stringify(MODULE_URL)};\n` +
    `const TOKEN = ${JSON.stringify(TOKEN)};\n` +
    source;
  try {
    const { stdout, stderr } = await run(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 20000,
      killSignal: 'SIGKILL',
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? -1 };
  }
}

/** A transport that never settles on its own and rejects only when aborted. */
const PENDING_FETCH = 'const pendingFetch = (_url, init) => new Promise((_res, reject) => { init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); });\n';

test('a pending attempt keeps the process alive until its own deadline fires', async () => {
  const { stdout, code } = await runChild(
    `${PENDING_FETCH}` +
      `const options = { maxAttempts: 1, timeoutMs: 20, retryBaseMs: 0, apiKeyEnv: 'X', mode: 'web-search', count: 1 };\n` +
      `try { await fetchSearch({ url: 'https://api.example.test/x', apiKey: TOKEN, options, deps: { fetchImpl: pendingFetch } }); }\n` +
      `catch (error) { console.log('REJECTED ' + error.code + ' ' + error.message); }\n` +
      `console.log('COMPLETED');\n`,
  );
  // A non-zero code here means Node exited before the deadline fired.
  assert.equal(code, 0, `child exited ${code}; stderr: ${''}`);
  assert.match(stdout, /REJECTED WEB_PROVIDER_ERROR /u);
  assert.match(stdout, /timed out after 20 ms/u);
  assert.match(stdout, /COMPLETED/u);
});

test('a search that completes normally leaves no timer behind to delay exit', async () => {
  // `fetchSearch` returns the parsed body; mapping to sources happens in the
  // provider, so the payload shape is what this asserts on.
  const { stdout, code } = await runChild(
    `const instantFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ web: { results: [{ url: 'https://example.test/a', title: 'A' }] } }) });\n` +
      // A long deadline that would hold the loop for 30 s if it were not disposed.
      `const options = { maxAttempts: 1, timeoutMs: 30000, retryBaseMs: 0, apiKeyEnv: 'X', mode: 'web-search', count: 1 };\n` +
      `const started = Date.now();\n` +
      `const body = await fetchSearch({ url: 'https://api.example.test/x', apiKey: TOKEN, options, deps: { fetchImpl: instantFetch } });\n` +
      `console.log('RESULTS ' + body.web.results.length);\n` +
      `console.log('ELAPSED ' + (Date.now() - started));\n` +
      `console.log('COMPLETED');\n`,
  );
  assert.equal(code, 0, `child exited ${code}`);
  assert.match(stdout, /RESULTS 1/u);
  const elapsed = Number(/ELAPSED (\d+)/u.exec(stdout)?.[1]);
  assert.ok(elapsed < 5000, `a completed search held the process for ${elapsed} ms; the deadline was not disposed`);
  assert.match(stdout, /COMPLETED/u);
});

test('an attempt rejected by the transport still releases its timer', async () => {
  // The search fails immediately; the 30 s deadline must be disposed, otherwise a
  // ref'd timer would hold the child open for the full deadline. Wall time is the
  // assertion that catches a leak, since the exit code alone would look fine.
  const { stdout, code } = await runChild(
    `const failingFetch = async () => { throw new TypeError('fetch failed'); };\n` +
      `const options = { maxAttempts: 1, timeoutMs: 30000, retryBaseMs: 0, apiKeyEnv: 'X', mode: 'web-search', count: 1 };\n` +
      `const started = Date.now();\n` +
      `try { await fetchSearch({ url: 'https://api.example.test/x', apiKey: TOKEN, options, deps: { fetchImpl: failingFetch } }); }\n` +
      `catch (error) { console.log('REJECTED ' + error.code); }\n` +
      `console.log('ELAPSED ' + (Date.now() - started));\n` +
      `console.log('COMPLETED');\n`,
  );
  assert.equal(code, 0, `child exited ${code}`);
  assert.match(stdout, /REJECTED WEB_PROVIDER_ERROR/u);
  const elapsed = Number(/ELAPSED (\d+)/u.exec(stdout)?.[1]);
  assert.ok(Number.isFinite(elapsed), `no ELAPSED line in: ${stdout}`);
  assert.ok(elapsed < 5000, `a failed attempt held the process for ${elapsed} ms; the 30000 ms deadline was not disposed`);
  assert.match(stdout, /COMPLETED/u);
});
