// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Transport behavior: URL and parameter construction, retry policy, timeout and
 * cancellation classification, throttling, and the guarantee that the
 * subscription token never leaves the request header.
 *
 * Every test drives an injected fetch implementation, so nothing here touches
 * the network and no real credential is ever involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_RETRY_AFTER_MS,
  RequestThrottle,
  SUBSCRIPTION_TOKEN_HEADER,
  buildQuery,
  buildUrl,
  fetchSearch,
  isRedirectError,
  isRetryableStatus,
  parseRetryAfter,
  retryDelayMs,
  sleepMs,
} from '../lib/client.js';
import { DEFAULT_API_KEY_ENV } from '../lib/config.js';
import { WEB_ABORTED, WEB_PROVIDER_CREDENTIAL_MISSING, WEB_PROVIDER_ERROR } from '../lib/errors.js';

/** An obvious fixture, never a usable credential. */
const SUBSCRIPTION_TOKEN = 'brave-fixture-value-not-a-real-credential';

/** Options with only the fields the transport reads, fully resolved. */
function transportOptions(overrides = {}) {
  return {
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    baseURL: 'https://api.example.test/res/v1',
    mode: 'llm-context',
    country: 'us',
    searchLang: 'en',
    count: 20,
    maxTokens: 8192,
    timeoutMs: 5000,
    maxAttempts: 3,
    retryBaseMs: 250,
    minIntervalMs: 0,
    ...overrides,
  };
}

/** A fetch stand-in that replays scripted steps and records every call. */
function scriptedFetch(steps) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (step === undefined) throw new Error('the scripted fetch received an unexpected call');
    if (step.reject !== undefined) throw step.reject;
    const body = step.text ?? (step.body === undefined ? '' : JSON.stringify(step.body));
    return new Response(body, {
      status: step.status ?? 200,
      headers: { 'content-type': step.text === undefined ? 'application/json' : 'text/plain', ...(step.headers ?? {}) },
    });
  };
  impl.calls = calls;
  return impl;
}

/**
 * A fetch stand-in that settles only when its combined signal aborts, like undici
 * does.
 *
 * `Promise.withResolvers()` would be tidier, but it is Node 22+ and `engines`
 * allows Node 20 — where calling it throws, turning every test that reaches this
 * helper into a spurious transport failure. The underscore-prefixed `resolve` is
 * the portable spelling of the same thing.
 */
function abortAwareFetch() {
  const calls = [];
  const impl = (url, init) => {
    calls.push({ url, init });
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  impl.calls = calls;
  return impl;
}

/** A sleep stand-in that records its delays and resolves immediately. */
function recordingSleep() {
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
  };
  sleep.delays = delays;
  return sleep;
}

/** Assert a rejection is a seam error carrying `code` and a message matching `pattern`. */
async function rejectsWith(promise, code, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return true;
  });
}

test('buildQuery targets the LLM Context endpoint with the llm-context parameters', () => {
  const query = buildQuery(transportOptions(), { query: 'cordis plugin lifecycle' });
  assert.equal(query.endpoint, 'https://api.example.test/res/v1/llm/context');
  assert.deepEqual(query.params, {
    q: 'cordis plugin lifecycle',
    country: 'us',
    search_lang: 'en',
    count: 20,
    maximum_number_of_urls: 20,
    maximum_number_of_tokens: 8192,
  });
});

test('buildQuery targets the Web Search endpoint with clean-text parameters', () => {
  const query = buildQuery(transportOptions({ mode: 'web-search', count: 5 }), { query: 'brave' });
  assert.equal(query.endpoint, 'https://api.example.test/res/v1/web/search');
  assert.deepEqual(query.params, {
    q: 'brave',
    country: 'us',
    search_lang: 'en',
    count: 5,
    text_decorations: 'false',
    result_filter: 'web',
  });
});

test('buildQuery sends only the optional parameters that are configured', () => {
  const bare = buildQuery(transportOptions(), { query: 'q' });
  assert.equal('freshness' in bare.params, false);
  assert.equal('safesearch' in bare.params, false);
  assert.equal('context_threshold_mode' in bare.params, false);
  const configured = buildQuery(
    transportOptions({ safesearch: 'strict', freshness: 'py', contextThresholdMode: 'lenient' }),
    { query: 'q' },
  );
  assert.equal(configured.params.safesearch, 'strict');
  assert.equal(configured.params.freshness, 'py');
  assert.equal(configured.params.context_threshold_mode, 'lenient');
  const webMode = buildQuery(transportOptions({ mode: 'web-search', safesearch: 'off' }), { query: 'q' });
  assert.equal(webMode.params.safesearch, 'off');
  assert.equal('context_threshold_mode' in webMode.params, false);
});

test('buildQuery clamps the count per mode and lets maxResults win', () => {
  assert.equal(buildQuery(transportOptions({ count: 50 }), { query: 'q' }).params.count, 50);
  assert.equal(buildQuery(transportOptions({ count: 50, mode: 'web-search' }), { query: 'q' }).params.count, 20);
  assert.equal(buildQuery(transportOptions(), { query: 'q', maxResults: 8 }).params.count, 8);
  assert.equal(buildQuery(transportOptions(), { query: 'q', maxResults: 8 }).params.maximum_number_of_urls, 8);
  assert.equal(buildQuery(transportOptions(), { query: 'q', maxResults: 80 }).params.count, 50);
  assert.equal(buildQuery(transportOptions({ mode: 'web-search' }), { query: 'q', maxResults: 80 }).params.count, 20);
  assert.equal(buildQuery(transportOptions({ mode: 'web-search', count: 5 }), { query: 'q', maxResults: 0 }).params.count, 5);
});

test('buildQuery tolerates a trailing slash on the base URL', () => {
  assert.equal(buildQuery(transportOptions({ baseURL: 'https://api.example.test/res/v1/' }), { query: 'q' }).endpoint, 'https://api.example.test/res/v1/llm/context');
});

test('buildUrl percent-encodes every parameter value', () => {
  assert.equal(buildUrl('https://api.example.test/res/v1/web/search', { q: 'a b&c=d', count: 8 }), 'https://api.example.test/res/v1/web/search?q=a+b%26c%3Dd&count=8');
  assert.equal(buildUrl('https://api.example.test/x', {}), 'https://api.example.test/x');
  assert.equal(buildUrl('https://api.example.test/x', { skipped: undefined }), 'https://api.example.test/x');
});

test('parseRetryAfter accepts seconds, HTTP dates, and rejects nonsense', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(' 3 '), 3000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('9999'), MAX_RETRY_AFTER_MS);
  assert.equal(parseRetryAfter('Wed, 01 Jan 2026 00:00:05 GMT', now), 5000);
  // A date already in the past means "retry now", not "no guidance".
  assert.equal(parseRetryAfter('Wed, 01 Jan 2020 00:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.equal(parseRetryAfter(''), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter(null), undefined);
});

test('retryDelayMs doubles per attempt and prefers a server Retry-After', () => {
  assert.equal(retryDelayMs(1, undefined, 250), 250);
  assert.equal(retryDelayMs(2, undefined, 250), 500);
  assert.equal(retryDelayMs(3, undefined, 250), 1000);
  assert.equal(retryDelayMs(1, 0, 250), 0);
  assert.equal(retryDelayMs(1, 5000, 250), 5000);
  assert.equal(retryDelayMs(1, undefined, 0), 0);
});

test('isRetryableStatus retries rate limits, request timeouts, and server faults only', () => {
  for (const status of [408, 429, 500, 502, 503, 504, 599]) assert.equal(isRetryableStatus(status), true, String(status));
  for (const status of [200, 201, 400, 401, 403, 404, 422, 451]) assert.equal(isRetryableStatus(status), false, String(status));
});

test('isRedirectError recognizes the refusal that must not be retried', () => {
  assert.equal(isRedirectError(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })), true);
  assert.equal(isRedirectError(new Error('redirect not allowed')), true);
  assert.equal(isRedirectError(new TypeError('fetch failed', { cause: Object.assign(new Error('bad redirect'), { code: 'ERR_INVALID_REDIRECT' }) })), true);
  assert.equal(isRedirectError(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') })), false);
  assert.equal(isRedirectError(undefined), false);
  // A transport failure for a host whose *name* contains "redirect" is not a
  // refused redirect; a substring match used to misclassify it as permanent, so
  // that search was never retried.
  assert.equal(isRedirectError(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND redirect.example.test') })), false);
  assert.equal(isRedirectError(new Error('the redirect proxy is unreachable')), false);
});

test('a non-JSON body with no usable detail does not leave a dangling colon', async () => {
  // An unreadable or blank body must drop the detail clause entirely rather than
  // render "HTTP 500: " with nothing after it.
  const failure = new TypeError('fetch failed', { cause: new Error('socket closed') });
  const response = {
    ok: false,
    status: 500,
    headers: new Headers(),
    text: async () => {
      throw failure;
    },
  };
  const error = await fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions({ maxAttempts: 1 }), deps: { fetchImpl: async () => response } }).then(
    () => undefined,
    (thrown) => thrown,
  );
  assert.match(error.message, /HTTP 500/u);
  assert.equal(/\):\s*$/u.test(error.message), false, `the message must not end in a bare colon: ${error.message}`);
});

test('an empty 200 body is reported as empty rather than as a bare colon', async () => {
  const fetchImpl = scriptedFetch([{ status: 200, text: '' }]);
  await rejectsWith(
    fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions({ maxAttempts: 1 }), deps: { fetchImpl } }),
    WEB_PROVIDER_ERROR,
    /HTTP 200\) \(the body was empty\)/u,
  );
});

test('a cancellation signal of the wrong type never surfaces as a raw TypeError', async () => {
  // `AbortSignal.any` validates its inputs, but not consistently across the
  // supported range: on Node 22 and newer it throws a `TypeError` for anything
  // that is not an `AbortSignal`, while on Node 20 it accepts a duck-typed
  // object and proceeds. The transport guards the call either way, so the test
  // asserts the property that actually holds on every version — a misuse never
  // escapes the seam as a non-`WebError` — rather than one version's behavior.
  const fetchImpl = scriptedFetch([{ body: { ok: true } }]);
  const error = await fetchSearch({
    url: 'https://api.example.test/x',
    apiKey: SUBSCRIPTION_TOKEN,
    options: transportOptions(),
    signal: { aborted: false },
    deps: { fetchImpl },
  }).then(
    () => undefined,
    (thrown) => thrown,
  );
  if (error !== undefined) {
    assert.equal(error instanceof TypeError, false, `a raw TypeError escaped the seam: ${error.message}`);
    assert.equal(error.code, WEB_PROVIDER_ERROR);
  }
});

test('no failure message can echo the subscription token', async () => {
  const fetchImpl = scriptedFetch([{ status: 401, body: { error: { detail: 'rejected token ' + SUBSCRIPTION_TOKEN } } }]);
  const error = await fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), deps: { fetchImpl } }).then(
    () => undefined,
    (thrown) => thrown,
  );
  assert.ok(error instanceof Error);
  assert.equal(error.message.includes(SUBSCRIPTION_TOKEN), false);
  assert.match(error.message, /\[redacted\]/u);
  const networkFailure = await fetchSearch({
    url: 'https://api.example.test/x',
    apiKey: SUBSCRIPTION_TOKEN,
    options: transportOptions({ maxAttempts: 1 }),
    deps: { fetchImpl: scriptedFetch([{ reject: new TypeError('fetch failed', { cause: new Error('proxy rejected ' + SUBSCRIPTION_TOKEN) }) }]) },
  }).then(
    () => undefined,
    (thrown) => thrown,
  );
  assert.equal(networkFailure.message.includes(SUBSCRIPTION_TOKEN), false);
});

test('RequestThrottle serializes concurrent dispatches', async () => {
  const throttle = new RequestThrottle();
  const order = [];
  const first = throttle.schedule(async () => {
    order.push('first:start');
    await sleepMs(10);
    order.push('first:end');
  });
  const second = throttle.schedule(async () => {
    order.push('second:start');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
});

test('RequestThrottle keeps one failure from poisoning the chain', async () => {
  const throttle = new RequestThrottle();
  await assert.rejects(throttle.schedule(async () => {
    throw new Error('boom');
  }));
  assert.equal(await throttle.schedule(async () => 'still working'), 'still working');
});

test('RequestThrottle spaces dispatch starts by minIntervalMs', async () => {
  let clock = 1000;
  const waits = [];
  const throttle = new RequestThrottle({ now: () => clock });
  const sleep = async (ms) => {
    waits.push(ms);
    clock += ms;
  };
  await throttle.schedule(async () => 'first', { minIntervalMs: 200, sleep });
  await throttle.schedule(async () => 'second', { minIntervalMs: 200, sleep });
  clock += 50;
  await throttle.schedule(async () => 'third', { minIntervalMs: 200, sleep });
  clock += 500;
  await throttle.schedule(async () => 'fourth', { minIntervalMs: 200, sleep });
  assert.deepEqual(waits, [200, 150]);
});

test('RequestThrottle refuses to start a queued dispatch for an aborted caller', async () => {
  const throttle = new RequestThrottle();
  const controller = new AbortController();
  controller.abort();
  await rejectsWith(throttle.schedule(async () => 'never', { signal: controller.signal }), WEB_ABORTED);
});

test('sleepMs resolves, and rejects with WEB_ABORTED when cancelled', async () => {
  await sleepMs(5);
  await sleepMs(0);
  const already = new AbortController();
  already.abort();
  await rejectsWith(sleepMs(50, already.signal), WEB_ABORTED);
  const during = new AbortController();
  const pending = sleepMs(5000, during.signal);
  during.abort();
  await rejectsWith(pending, WEB_ABORTED);
});

test('fetchSearch sends one authenticated GET that refuses redirects', async () => {
  const fetchImpl = scriptedFetch([{ body: { ok: true } }]);
  const payload = await fetchSearch({ url: 'https://api.example.test/res/v1/llm/context?q=x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), deps: { fetchImpl } });
  assert.deepEqual(payload, { ok: true });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers[SUBSCRIPTION_TOKEN_HEADER], SUBSCRIPTION_TOKEN);
  assert.equal(init.headers.accept, 'application/json');
  assert.equal('accept-encoding' in init.headers, false);
  assert.equal(url.includes(SUBSCRIPTION_TOKEN), false);
  assert.ok(init.signal instanceof AbortSignal);
});

test('fetchSearch retries a 429 and then succeeds', async () => {
  const fetchImpl = scriptedFetch([{ status: 429, body: { error: { detail: 'slow down' } } }, { body: { ok: true } }]);
  const sleep = recordingSleep();
  const payload = await fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), deps: { fetchImpl, sleep } });
  assert.deepEqual(payload, { ok: true });
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(sleep.delays, [250]);
});

test('fetchSearch honors Retry-After over the computed backoff', async () => {
  const fetchImpl = scriptedFetch([{ status: 429, body: {}, headers: { 'retry-after': '1' } }, { body: { ok: true } }]);
  const sleep = recordingSleep();
  await fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), deps: { fetchImpl, sleep } });
  assert.deepEqual(sleep.delays, [1000]);
});

test('fetchSearch never retries an authentication or authorization failure', async () => {
  for (const status of [401, 403]) {
    const fetchImpl = scriptedFetch([{ status, body: { error: { detail: 'bad token' } } }]);
    const sleep = recordingSleep();
    await rejectsWith(
      fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), deps: { fetchImpl, sleep } }),
      WEB_PROVIDER_ERROR,
      new RegExp('HTTP ' + status, 'u'),
    );
    assert.equal(fetchImpl.calls.length, 1, 'status ' + status + ' must not be retried');
    assert.deepEqual(sleep.delays, []);
  }
});

test('fetchSearch reports the HTTP status and the API detail in the message', async () => {
  const fetchImpl = scriptedFetch([{ status: 422, body: { error: { detail: 'query is required' } } }]);
  await rejectsWith(
    fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), deps: { fetchImpl } }),
    WEB_PROVIDER_ERROR,
    /HTTP 422\): query is required/u,
  );
});

test('fetchSearch gives up after maxAttempts retryable failures', async () => {
  const fetchImpl = scriptedFetch([{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }, { body: { ok: true } }]);
  const sleep = recordingSleep();
  await rejectsWith(
    fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), deps: { fetchImpl, sleep } }),
    WEB_PROVIDER_ERROR,
    /HTTP 503/u,
  );
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(sleep.delays, [250, 500]);
});

test('fetchSearch retries a transient transport failure and reports exhaustion', async () => {
  const failure = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1') });
  const fetchImpl = scriptedFetch([{ reject: failure }, { reject: failure }, { reject: failure }, { body: { ok: true } }]);
  const sleep = recordingSleep();
  await rejectsWith(
    fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), deps: { fetchImpl, sleep } }),
    WEB_PROVIDER_ERROR,
    /failed after 3 attempt/u,
  );
  assert.equal(fetchImpl.calls.length, 3);
});

test('fetchSearch refuses a redirect without retrying it', async () => {
  const refusal = new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  const fetchImpl = scriptedFetch([{ reject: refusal }, { body: { ok: true } }]);
  await rejectsWith(
    fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), deps: { fetchImpl } }),
    WEB_PROVIDER_ERROR,
    /redirect/u,
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('fetchSearch classifies its own timeout as a provider error naming the limit', async () => {
  const fetchImpl = abortAwareFetch();
  await rejectsWith(
    fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions({ timeoutMs: 20, maxAttempts: 1 }), deps: { fetchImpl } }),
    WEB_PROVIDER_ERROR,
    /timed out after 20 ms/u,
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('fetchSearch classifies a caller cancellation as an abort', async () => {
  const fetchImpl = abortAwareFetch();
  const controller = new AbortController();
  const pending = fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions({ maxAttempts: 3 }), signal: controller.signal, deps: { fetchImpl } });
  controller.abort();
  await rejectsWith(pending, WEB_ABORTED, /aborted/u);
  assert.equal(fetchImpl.calls.length, 1);
});

test('fetchSearch refuses to start when the caller already cancelled', async () => {
  const fetchImpl = scriptedFetch([{ body: { ok: true } }]);
  const controller = new AbortController();
  controller.abort();
  await rejectsWith(
    fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), signal: controller.signal, deps: { fetchImpl } }),
    WEB_ABORTED,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('fetchSearch aborts the backoff when the caller cancels during it', async () => {
  const fetchImpl = scriptedFetch([{ status: 500, body: {} }, { body: { ok: true } }]);
  const controller = new AbortController();
  const sleep = async (ms, signal) => {
    controller.abort();
    await sleepMs(ms, signal);
  };
  await rejectsWith(
    fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), signal: controller.signal, deps: { fetchImpl, sleep } }),
    WEB_ABORTED,
  );
});

test('fetchSearch treats an unparseable body as a provider error', async () => {
  const fetchImpl = scriptedFetch([{ status: 200, text: '<html>not json</html>' }]);
  await rejectsWith(
    fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), deps: { fetchImpl } }),
    WEB_PROVIDER_ERROR,
    /not JSON/u,
  );
});

test('fetchSearch refuses to dispatch without a credential', async () => {
  const fetchImpl = scriptedFetch([{ body: { ok: true } }]);
  await rejectsWith(
    fetchSearch({ url: 'https://api.example.test/x', apiKey: '', options: transportOptions(), deps: { fetchImpl } }),
    WEB_PROVIDER_CREDENTIAL_MISSING,
    new RegExp(DEFAULT_API_KEY_ENV, 'u'),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('no failure message can echo the subscription token', async () => {
  const fetchImpl = scriptedFetch([{ status: 401, body: { error: { detail: 'rejected token ' + SUBSCRIPTION_TOKEN } } }]);
  const error = await fetchSearch({ url: 'https://api.example.test/x', apiKey: SUBSCRIPTION_TOKEN, options: transportOptions(), deps: { fetchImpl } }).then(
    () => undefined,
    (thrown) => thrown,
  );
  assert.ok(error instanceof Error);
  assert.equal(error.message.includes(SUBSCRIPTION_TOKEN), false);
  assert.match(error.message, /\[redacted\]/u);
  const networkFailure = await fetchSearch({
    url: 'https://api.example.test/x',
    apiKey: SUBSCRIPTION_TOKEN,
    options: transportOptions({ maxAttempts: 1 }),
    deps: { fetchImpl: scriptedFetch([{ reject: new TypeError('fetch failed', { cause: new Error('proxy rejected ' + SUBSCRIPTION_TOKEN) }) }]) },
  }).then(
    () => undefined,
    (thrown) => thrown,
  );
  assert.equal(networkFailure.message.includes(SUBSCRIPTION_TOKEN), false);
});
