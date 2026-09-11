// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * End-to-end provider behavior against a local HTTP server standing in for
 * Brave: both modes, both credential routes, the retry and cancellation
 * outcomes, the availability check, and the guarantee that the subscription
 * token reaches Brave only in the request header.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { SUBSCRIPTION_TOKEN_HEADER } from '../lib/client.js';
import { DEFAULT_API_KEY_ENV, PROVIDER_ID, SEARCH_REQUEST_EVENT, resolveOptions } from '../lib/config.js';
import { WEB_ABORTED, WEB_PROVIDER_CREDENTIAL_MISSING, WEB_PROVIDER_ERROR } from '../lib/errors.js';
import { BraveSearchProvider } from '../lib/provider.js';
import { MOCK_LLM_CONTEXT_PATH, MOCK_WEB_SEARCH_PATH, llmContextBody, startMockBrave, webSearchBody } from './helpers/mock-brave.js';
import { missingToolExecFile, scriptedExecFile } from './helpers/fake-secret-tools.js';

/** An obvious fixture, never a usable credential. */
const SUBSCRIPTION_TOKEN = 'brave-fixture-value-not-a-real-credential';

/** A context whose environment and services are exactly what the test passes. */
function contextWith({ environment = {}, credentials, events } = {}) {
  const snapshot = createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]);
  return {
    get(name) {
      if (name === 'launchEnvironment') return snapshot;
      if (name === 'credentials') return credentials;
      if (name === 'agents') {
        return events === undefined ? undefined : { currentInitiator: () => ({ session: { append: (eventName, payload) => events.push({ eventName, payload }) } }) };
      }
      return undefined;
    },
  };
}

/** Start a mock server and a provider pointed at it, closed automatically. */
async function startHarness(t, { config = {}, environment, credentials, events, script = [], execFile } = {}) {
  const server = await startMockBrave();
  t.after(() => server.close());
  for (const step of script) server.enqueue(step);
  const resolvedEnvironment = environment ?? { [DEFAULT_API_KEY_ENV]: SUBSCRIPTION_TOKEN };
  const ctx = contextWith({ environment: resolvedEnvironment, credentials, events });
  const secretRunner = execFile ?? missingToolExecFile();
  const build = (deps) => resolveOptions(ctx, { baseURL: server.baseURL, ...config }, { execFile: secretRunner, ...(deps ?? {}) });
  const options = build();
  return { server, options, provider: new BraveSearchProvider((deps) => build(deps)) };
}

/** Run a search and return the thrown error instead of failing the test. */
async function capture(promise) {
  return await promise.then(
    () => undefined,
    (error) => error,
  );
}

/** Assert a rejection is a seam error carrying `code` and a message matching `pattern`. */
async function rejectsWith(promise, code, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return true;
  });
}

test('llm-context mode maps a real response and sends the documented parameters', async (t) => {
  const { server, provider } = await startHarness(t, {
    script: [
      {
        body: llmContextBody({
          generic: [{ url: 'https://example.test/a', title: 'A', snippets: ['one', 'two'] }],
          sources: { 'https://example.test/a': { age: ['Monday', '2024-01-15', '380 days ago', '2024-01-15T13:45:02Z'] } },
        }),
      },
    ],
  });
  const result = await provider.search({ query: 'cordis plugin lifecycle', maxResults: 8 });
  assert.deepEqual(result, {
    sources: [{ url: 'https://example.test/a', title: 'A', snippet: 'one\n\ntwo', publishedAt: '2024-01-15T13:45:02Z' }],
    truncated: false,
  });
  assert.equal(server.requests.length, 1);
  const request = server.requests[0];
  assert.equal(request.method, 'GET');
  assert.equal(request.path, MOCK_LLM_CONTEXT_PATH);
  assert.equal(request.params.q, 'cordis plugin lifecycle');
  assert.equal(request.params.count, '8');
  assert.equal(request.params.maximum_number_of_urls, '8');
  assert.equal(request.params.maximum_number_of_tokens, '8192');
  assert.equal(request.params.country, 'us');
  assert.equal(request.params.search_lang, 'en');
});

test('web-search mode maps a real response and asks for clean text', async (t) => {
  const { server, provider } = await startHarness(t, {
    config: { mode: 'web-search', safesearch: 'strict', freshness: 'py' },
    script: [{ body: webSearchBody({ results: [{ url: 'https://example.test/a', title: 'A', description: 'clean text', page_age: '2024-01-15' }] }) }],
  });
  const result = await provider.search({ query: 'brave search api' });
  assert.deepEqual(result.sources, [{ url: 'https://example.test/a', title: 'A', snippet: 'clean text', publishedAt: '2024-01-15' }]);
  const request = server.requests[0];
  assert.equal(request.path, MOCK_WEB_SEARCH_PATH);
  assert.equal(request.params.text_decorations, 'false');
  assert.equal(request.params.result_filter, 'web');
  assert.equal(request.params.safesearch, 'strict');
  assert.equal(request.params.freshness, 'py');
  assert.equal('maximum_number_of_tokens' in request.params, false);
});

test('an empty result set is a result, not an error', async (t) => {
  const { provider } = await startHarness(t, { script: [{ body: llmContextBody() }] });
  assert.deepEqual(await provider.search({ query: 'nothing matches' }), { sources: [], truncated: false });
});

test('a wrong-shaped body is an error rather than a silent empty answer', async (t) => {
  const { provider } = await startHarness(t, { script: [{ body: { unexpected: true } }] });
  await rejectsWith(provider.search({ query: 'q' }), WEB_PROVIDER_ERROR, /no "grounding" envelope/u);
});

test('a body that is not JSON at all is an error', async (t) => {
  const { provider } = await startHarness(t, { script: [{ raw: true, body: '<html>upstream proxy</html>' }] });
  await rejectsWith(provider.search({ query: 'q' }), WEB_PROVIDER_ERROR, /not JSON/u);
});

test('the request-level maxResults wins over the configured count', async (t) => {
  const { server, provider } = await startHarness(t, { config: { count: 30 }, script: [{ body: llmContextBody() }] });
  await provider.search({ query: 'q', maxResults: 8 });
  assert.equal(server.requests[0].params.count, '8');
});

test('the provider returns every source it received and never claims truncation', async (t) => {
  const { provider } = await startHarness(t, {
    script: [
      {
        body: llmContextBody({
          generic: [
            { url: 'https://example.test/a' },
            { url: 'https://example.test/b' },
            { url: 'https://example.test/c' },
          ],
        }),
      },
    ],
  });
  const result = await provider.search({ query: 'q', maxResults: 2 });
  assert.equal(result.sources.length, 3);
  assert.equal(result.truncated, false);
});

test('a missing credential is reported without any request leaving the process', async (t) => {
  const { server, provider } = await startHarness(t, { environment: {}, config: { secretManager: 'none' }, script: [{ body: llmContextBody() }] });
  const error = await capture(provider.search({ query: 'q' }));
  assert.equal(error.code, WEB_PROVIDER_CREDENTIAL_MISSING);
  assert.match(error.message, new RegExp(DEFAULT_API_KEY_ENV, 'u'));
  assert.match(error.message, /Settings > Plugins > Plugin configuration > Web search/u);
  assert.match(error.message, /names the credential and never supplies one/u, 'the message must teach the name-versus-value distinction');
  assert.equal(server.requests.length, 0);
});

test('a credential from the credential service authenticates the request', async (t) => {
  const asked = [];
  const credentials = {
    resolve: async (ref) => {
      asked.push(String(ref));
      return { value: SUBSCRIPTION_TOKEN, source: 'file' };
    },
  };
  const { server, provider } = await startHarness(t, { environment: {}, credentials, script: [{ body: llmContextBody() }] });
  await provider.search({ query: 'q' });
  assert.deepEqual(asked, [DEFAULT_API_KEY_ENV]);
  assert.equal(server.requests[0].headers[SUBSCRIPTION_TOKEN_HEADER], SUBSCRIPTION_TOKEN);
});

test('an unconfigured credential service does not fall back to the environment', async (t) => {
  const credentials = { resolve: async () => undefined };
  const { provider } = await startHarness(t, { credentials, script: [{ body: llmContextBody() }] });
  const error = await capture(provider.search({ query: 'q' }));
  assert.equal(error.code, WEB_PROVIDER_CREDENTIAL_MISSING);
  assert.match(error.message, /harness credential store/u);
  assert.equal(error.message.includes('launch environment'), false, 'the environment is not consulted while a credential service is mounted');
});

test('a key read from the GNOME keyring authenticates a real request', async (t) => {
  const execFile = scriptedExecFile({ 'secret-tool lookup service dsh-web-search-brave': SUBSCRIPTION_TOKEN });
  const { server, provider } = await startHarness(t, { environment: {}, execFile, script: [{ body: llmContextBody({ generic: [{ url: 'https://example.test/a' }] }) }] });
  const result = await provider.search({ query: 'q' });
  assert.equal(result.sources.length, 1);
  assert.equal(server.requests[0].headers[SUBSCRIPTION_TOKEN_HEADER], SUBSCRIPTION_TOKEN);
  assert.deepEqual(execFile.calls.map((call) => call.file), ['secret-tool']);
});

test('a key read from pass is used when the keyring has nothing', async (t) => {
  const execFile = scriptedExecFile({ 'pass show dsh/brave-search-api': SUBSCRIPTION_TOKEN + '\nnotes\n' });
  const { server, provider } = await startHarness(t, { environment: {}, execFile, config: { secretManager: 'pass' }, script: [{ body: llmContextBody({ generic: [{ url: 'https://example.test/a' }] }) }] });
  const result = await provider.search({ query: 'q' });
  assert.equal(result.sources.length, 1);
  assert.equal(server.requests[0].headers[SUBSCRIPTION_TOKEN_HEADER], SUBSCRIPTION_TOKEN);
  assert.deepEqual(execFile.calls.map((call) => call.file), ['pass']);
});

test('a key pasted into the reference field is never echoed in the failure', async (t) => {
  const pasted = 'BSA' + 'A'.repeat(28);
  const { provider } = await startHarness(t, { environment: {}, config: { apiKeyEnv: pasted, secretManager: 'none' }, script: [] });
  const error = await capture(provider.search({ query: 'q' }));
  assert.equal(error.code, WEB_PROVIDER_CREDENTIAL_MISSING);
  assert.equal(error.message.includes(pasted), false, 'the pasted value must not be copied into the message');
  assert.match(error.message, /it looks like a key, not a name/u);
  // The settings service still persists whatever was typed into the field, so the
  // message must say so rather than leaving the operator believing nothing was
  // written down anywhere.
  assert.match(error.message, /rotate it/u);
});

test('a pasted key of any vendor shape is withheld, not just a Brave one', async (t) => {
  // The reference field is free text. A key pasted from another vendor is not a
  // Brave token, but it is still a secret that must not reach a message the model
  // and the session log both read.
  for (const pasted of ['AKIA' + 'IOSFODNN7EXAMPLE', 'ghp_' + 'AbCdEfGhIjKlMnOpQrStUvWx', 'sk-' + 'AbCdEfGhIjKlMnOpQrStUvWx']) {
    const { provider } = await startHarness(t, { environment: {}, config: { apiKeyEnv: pasted, secretManager: 'none' }, script: [] });
    const error = await capture(provider.search({ query: 'q' }));
    assert.equal(error.code, WEB_PROVIDER_CREDENTIAL_MISSING);
    assert.equal(error.message.includes(pasted), false, `${pasted.slice(0, 4)}… must not be echoed`);
  }
});

test('a request with no usable query is rejected before the credential is resolved', async (t) => {
  // The transport would otherwise send `q=undefined`, and a non-JSON-safe value
  // would make the session refuse the recorded request event. Both are caller
  // errors, and neither should reach Brave as a malformed search.
  const asked = [];
  const credentials = {
    resolve: async (ref) => {
      asked.push(String(ref));
      return { value: SUBSCRIPTION_TOKEN, source: 'file' };
    },
  };
  const { server, provider } = await startHarness(t, { environment: {}, credentials, script: [{ body: llmContextBody() }] });
  for (const request of [{}, { query: '' }, { query: '   ' }, { query: undefined }, { query: 42 }]) {
    const error = await capture(provider.search(request));
    assert.equal(error.code, WEB_PROVIDER_ERROR, `${JSON.stringify(request)} must be a provider-input error`);
    assert.match(error.message, /non-empty string query/u);
  }
  assert.deepEqual(asked, [], 'no credential should be resolved for a request that cannot be dispatched');
  assert.equal(server.requests.length, 0, 'nothing may reach the network');
});

test('the missing-credential error lists every source that was tried', async (t) => {
  const { provider } = await startHarness(t, { environment: {}, script: [] });
  const error = await capture(provider.search({ query: 'q' }));
  assert.equal(error.code, WEB_PROVIDER_CREDENTIAL_MISSING);
  assert.match(error.message, /Where the key was looked for, in order:/u);
  assert.match(error.message, /gnome-keyring/u);
  assert.match(error.message, /pass \(/u);
  assert.match(error.message, /launch environment/u);
});

test('a failing credential provider is reported without echoing its own message', async (t) => {
  // This path has no resolved value to redact against, so the underlying error's
  // text cannot be trusted to be secret-free: a credential provider is free to
  // quote what it read. Only the error's name and a labelled reference are safe.
  const secretInError = 'bsa' + 'Z'.repeat(30);
  const credentials = {
    resolve: async () => {
      throw new Error(`could not read the stored value ${secretInError}`);
    },
  };
  const { server, provider } = await startHarness(t, { credentials, script: [{ body: llmContextBody() }] });
  const error = await capture(provider.search({ query: 'q' }));
  assert.equal(error.code, WEB_PROVIDER_ERROR);
  assert.equal(error.message.includes(secretInError), false, 'the provider error text must not be copied through');
  assert.match(error.message, /credential resolution failed/u);
  assert.match(error.message, /Error/u, 'the error name is the only part that is surfaced');
  assert.equal(server.requests.length, 0);
});

test('a 429 is retried and the search still succeeds', async (t) => {
  const { server, provider } = await startHarness(t, {
    config: { retryBaseMs: 1 },
    script: [{ status: 429, body: { error: { detail: 'rate limited' } }, headers: { 'retry-after': '0' } }, { body: llmContextBody({ generic: [{ url: 'https://example.test/a' }] }) }],
  });
  const result = await provider.search({ query: 'q' });
  assert.equal(result.sources.length, 1);
  assert.equal(server.requests.length, 2);
});

test('a dropped connection is retried as a transient failure', async (t) => {
  const { server, provider } = await startHarness(t, {
    config: { retryBaseMs: 1 },
    script: [{ drop: true }, { body: llmContextBody({ generic: [{ url: 'https://example.test/a' }] }) }],
  });
  const result = await provider.search({ query: 'q' });
  assert.equal(result.sources.length, 1);
  assert.equal(server.requests.length, 2);
});

test('an authentication failure is not retried and carries the status', async (t) => {
  const { server, provider } = await startHarness(t, { script: [{ status: 401, body: { error: { detail: 'invalid token' } } }] });
  await rejectsWith(provider.search({ query: 'q' }), WEB_PROVIDER_ERROR, /HTTP 401\): invalid token/u);
  assert.equal(server.requests.length, 1);
});

test('retries are exhausted and the failure carries the last status', async (t) => {
  const { server, provider } = await startHarness(t, {
    config: { retryBaseMs: 1 },
    script: [{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }, { body: llmContextBody() }],
  });
  await rejectsWith(provider.search({ query: 'q' }), WEB_PROVIDER_ERROR, /HTTP 503/u);
  assert.equal(server.requests.length, 3);
});

test('a response that never arrives fails as a timeout naming the limit', async (t) => {
  const { provider } = await startHarness(t, { config: { timeoutMs: 80, maxAttempts: 1 }, script: [{ hang: true }] });
  await rejectsWith(provider.search({ query: 'q' }), WEB_PROVIDER_ERROR, /timed out after 80 ms/u);
});

test('cancelling the caller aborts the search', async (t) => {
  const { provider } = await startHarness(t, { script: [{ hang: true }] });
  const controller = new AbortController();
  const pending = provider.search({ query: 'q' }, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await rejectsWith(pending, WEB_ABORTED, /aborted/u);
});

test('the subscription token travels only in the request header', async (t) => {
  const events = [];
  const { server, provider } = await startHarness(t, { events, script: [{ body: llmContextBody() }] });
  await provider.search({ query: 'q' });
  const request = server.requests[0];
  assert.equal(request.headers[SUBSCRIPTION_TOKEN_HEADER], SUBSCRIPTION_TOKEN);
  assert.equal(request.url.includes(SUBSCRIPTION_TOKEN), false);
  assert.equal(JSON.stringify(request.headers).includes(SUBSCRIPTION_TOKEN), true);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(SUBSCRIPTION_TOKEN), false);
  assert.equal(serialized.includes('x-subscription-token'), false);
});

test('the recorded request event carries the endpoint, mode, query, and non-secret parameters', async (t) => {
  const events = [];
  const { server, provider } = await startHarness(t, { events, config: { count: 7 }, script: [{ body: llmContextBody() }] });
  await provider.search({ query: 'cordis plugins', maxResults: 4 });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventName, SEARCH_REQUEST_EVENT);
  assert.deepEqual(events[0].payload, {
    provider: PROVIDER_ID,
    endpoint: server.origin + MOCK_LLM_CONTEXT_PATH,
    mode: 'llm-context',
    query: 'cordis plugins',
    params: { q: 'cordis plugins', country: 'us', search_lang: 'en', count: 4, maximum_number_of_urls: 4, maximum_number_of_tokens: 8192 },
  });
});

test('a settings change reaches the next search without re-registering the provider', async (t) => {
  const server = await startMockBrave();
  t.after(() => server.close());
  server.json(llmContextBody()).json(llmContextBody());
  const ctx = contextWith({ environment: { [DEFAULT_API_KEY_ENV]: SUBSCRIPTION_TOKEN } });
  let section = { baseURL: server.baseURL, count: 5 };
  const provider = new BraveSearchProvider(() => resolveOptions(ctx, section));
  await provider.search({ query: 'first' });
  section = { baseURL: server.baseURL, count: 7 };
  await provider.search({ query: 'second' });
  assert.deepEqual(server.requests.map((request) => request.params.count), ['5', '7']);
  assert.equal(provider.id, PROVIDER_ID);
});

test('available() fails closed for an explicitly unusable base URL, and only then', async (t) => {
  const { provider } = await startHarness(t, {});
  assert.equal(provider.available(), true);
  // A base URL that was *set* but cannot be used must not be replaced by the
  // default: doing so would send the subscription token to a host the operator did
  // not choose, which is the outcome the validation exists to prevent. The
  // provider therefore reports itself unavailable — the seam then skips it rather
  // than dispatching anywhere.
  for (const baseURL of ['not a url', '/res/v1', 'javascript:alert(1)', 'https://user:pass@example.test/res/v1']) {
    const refused = new BraveSearchProvider(() => resolveOptions(contextWith(), { baseURL }));
    assert.equal(refused.available(), false, `${baseURL} must leave the provider unavailable`);
    assert.equal(refused.available(), false, 'the check must stay local and repeatable');
  }
  // A resolved set that is unusable for any other reason reports false too.
  const unusable = new BraveSearchProvider(() => ({ ...resolveOptions(contextWith(), {}), minIntervalMs: Number.MAX_SAFE_INTEGER }));
  assert.equal(unusable.available(), false);
});

test('a blank base URL falls back to the default rather than counting as unusable', () => {
  const provider = new BraveSearchProvider(() => resolveOptions(contextWith(), { baseURL: '   ' }));
  assert.equal(provider.available(), true);
});

test('available() does not need a credential', () => {
  const provider = new BraveSearchProvider(() => resolveOptions(contextWith({ environment: {} }), {}));
  assert.equal(provider.available(), true);
});

test('available() answers false instead of throwing when option resolution fails', () => {
  const provider = new BraveSearchProvider(() => {
    throw new Error('no options');
  });
  assert.equal(provider.available(), false);
});

test('a credential-resolution failure is a provider error, not a crash', async (t) => {
  const credentials = {
    resolve: async () => {
      throw new Error('credential store unavailable');
    },
  };
  const { provider } = await startHarness(t, { environment: {}, credentials, script: [{ body: llmContextBody() }] });
  await rejectsWith(provider.search({ query: 'q' }), WEB_PROVIDER_ERROR, /credential resolution failed/u);
});

test('concurrent searches are serialized by the client-side throttle', async (t) => {
  const { server, provider } = await startHarness(t, {
    config: { minIntervalMs: 120 },
    script: [{ body: llmContextBody() }, { body: llmContextBody() }],
  });
  const started = Date.now();
  await Promise.all([provider.search({ query: 'first' }), provider.search({ query: 'second' })]);
  assert.equal(server.requests.length, 2);
  assert.ok(Date.now() - started >= 110, 'the second dispatch waited for the minimum interval');
});

test('search() resolves its options once per call', async (t) => {
  const server = await startMockBrave();
  t.after(() => server.close());
  server.json(llmContextBody());
  const ctx = contextWith({ environment: { [DEFAULT_API_KEY_ENV]: SUBSCRIPTION_TOKEN } });
  let revisions = 0;
  const provider = new BraveSearchProvider(() => {
    revisions += 1;
    return resolveOptions(ctx, { baseURL: server.baseURL });
  });
  await provider.search({ query: 'q' });
  assert.equal(revisions, 1);
});

test('capture() surfaces the error object for message inspection', async (t) => {
  const { provider } = await startHarness(t, { script: [{ status: 500, body: { error: { detail: 'server exploded' } } }], config: { maxAttempts: 1 } });
  const error = await capture(provider.search({ query: 'q' }));
  assert.equal(error.code, WEB_PROVIDER_ERROR);
  assert.match(error.message, /server exploded/u);
});
