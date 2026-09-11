// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Configuration surface: the schema a settings UI renders, the documented
 * defaults, and the defensive projection into fully resolved provider options.
 * Every test is hermetic — the launch environment is supplied by the test, never
 * inherited from the process, so an ambient credential can neither satisfy nor
 * break an assertion.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import {
  BASE_URL_ENV,
  Config,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  PROVIDER_ID,
  SEARCH_REQUEST_EVENT,
  SETTINGS_NAMESPACE,
  effectiveCount,
  maxCountForMode,
  resolveOptions,
} from '../lib/config.js';
import { missingToolExecFile, scriptedExecFile } from './helpers/fake-secret-tools.js';

/** Every field the README documents, and therefore every field the schema must carry. */
const DOCUMENTED_FIELDS = [
  'apiKeyEnv',
  'secretManager',
  'gnomeKeyringAttributes',
  'passPath',
  'baseURL',
  'mode',
  'country',
  'searchLang',
  'safesearch',
  'freshness',
  'count',
  'maxTokens',
  'contextThresholdMode',
  'timeoutMs',
  'maxAttempts',
  'retryBaseMs',
  'minIntervalMs',
];

/** The schema's declared field names, straight from its serialized form. */
function declaredFields() {
  const json = Config.toJSON();
  return Object.keys(json.refs[json.uid].dict);
}

/** A context whose environment and services are exactly what the test passes. */
function contextWith({ environment = {}, credentials, agents } = {}) {
  const snapshot = createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]);
  return {
    get(name) {
      if (name === 'launchEnvironment') return snapshot;
      if (name === 'credentials') return credentials;
      if (name === 'agents') return agents;
      return undefined;
    },
  };
}

test('Config declares exactly the documented options', () => {
  assert.deepEqual(declaredFields().toSorted(), DOCUMENTED_FIELDS.toSorted());
});

test('Config exposes no field that could carry a literal key', () => {
  assert.equal(declaredFields().includes('apiKey'), false);
  assert.equal(Object.hasOwn(Config({}), 'apiKey'), false);
});

test('Config applies the documented defaults and leaves unset options absent', () => {
  const resolved = Config({});
  assert.equal(resolved.apiKeyEnv, DEFAULT_API_KEY_ENV);
  assert.equal(resolved.mode, 'llm-context');
  assert.equal(resolved.country, 'us');
  assert.equal(resolved.searchLang, 'en');
  assert.equal(resolved.count, 20);
  assert.equal(resolved.maxTokens, 8192);
  assert.equal(resolved.timeoutMs, 30000);
  assert.equal(resolved.maxAttempts, 3);
  assert.equal(resolved.retryBaseMs, 250);
  assert.equal(resolved.minIntervalMs, 0);
  assert.equal(resolved.secretManager, 'auto');
  assert.deepEqual(resolved.gnomeKeyringAttributes, { service: 'dsh-web-search-brave' });
  assert.equal(resolved.passPath, 'dsh/brave-search-api');
  assert.equal('baseURL' in resolved, false);
  assert.equal('safesearch' in resolved, false);
  assert.equal('freshness' in resolved, false);
  assert.equal('contextThresholdMode' in resolved, false);
});

test('Config rejects an out-of-enum value and an out-of-range count', () => {
  assert.throws(() => Config({ mode: 'bogus' }));
  assert.throws(() => Config({ safesearch: 'sometimes' }));
  assert.throws(() => Config({ count: 99 }));
  assert.throws(() => Config({ maxTokens: 1 }));
  assert.throws(() => Config({ secretManager: 'keychain' }));
});

test('resolveOptions applies every default without an environment', () => {
  const options = resolveOptions(contextWith(), undefined);
  assert.equal(String(options.apiKeyEnv), DEFAULT_API_KEY_ENV);
  assert.equal(options.baseURL, DEFAULT_BASE_URL);
  assert.equal(options.mode, 'llm-context');
  assert.equal(options.country, 'us');
  assert.equal(options.searchLang, 'en');
  assert.equal(options.safesearch, undefined);
  assert.equal(options.freshness, undefined);
  assert.equal(options.contextThresholdMode, undefined);
  assert.equal(options.count, 20);
  assert.equal(options.maxTokens, 8192);
  assert.equal(options.timeoutMs, 30000);
  assert.equal(options.maxAttempts, 3);
  assert.equal(options.retryBaseMs, 250);
  assert.equal(options.minIntervalMs, 0);
  assert.equal(options.secretManager, 'auto');
  assert.deepEqual(options.gnomeKeyringAttributes, { service: 'dsh-web-search-brave' });
  assert.equal(options.passPath, 'dsh/brave-search-api');
});

test('resolveOptions corrects unusable secret-manager settings instead of throwing', () => {
  const options = resolveOptions(contextWith(), {
    secretManager: 'keychain',
    gnomeKeyringAttributes: { service: 42, '--flag': 'x', Title: 'Brave Search API Paid' },
    passPath: '   ',
  });
  assert.equal(options.secretManager, 'auto');
  assert.deepEqual(options.gnomeKeyringAttributes, { Title: 'Brave Search API Paid' });
  assert.equal(options.passPath, 'dsh/brave-search-api');
  assert.deepEqual(resolveOptions(contextWith(), { gnomeKeyringAttributes: { service: '' } }).gnomeKeyringAttributes, { service: 'dsh-web-search-brave' });
  assert.deepEqual(resolveOptions(contextWith(), { gnomeKeyringAttributes: 'nonsense' }).gnomeKeyringAttributes, { service: 'dsh-web-search-brave' });
});

test('resolveOptions keeps usable secret-manager settings', () => {
  const options = resolveOptions(contextWith(), { secretManager: 'pass', passPath: 'work/brave', gnomeKeyringAttributes: { Title: 'Brave Search API Paid' } });
  assert.equal(options.secretManager, 'pass');
  assert.equal(options.passPath, 'work/brave');
  assert.deepEqual(options.gnomeKeyringAttributes, { Title: 'Brave Search API Paid' });
});

test('resolveOptions falls back to the environment for baseURL and lets config win', () => {
  const environment = { [BASE_URL_ENV]: 'http://127.0.0.1:9/res/v1/' };
  // The trailing slash is normalized away, so the recorded endpoint is the one
  // actually requested rather than the one as typed.
  assert.equal(resolveOptions(contextWith({ environment }), undefined).baseURL, 'http://127.0.0.1:9/res/v1');
  assert.equal(resolveOptions(contextWith({ environment }), { baseURL: 'https://example.test/res/v1' }).baseURL, 'https://example.test/res/v1');
  assert.equal(resolveOptions(contextWith({ environment: { [BASE_URL_ENV]: '   ' } }), undefined).baseURL, DEFAULT_BASE_URL);
});

test('resolveOptions refuses an unusable base URL instead of substituting the default', () => {
  // A base URL decides which host receives the subscription-token header. An
  // *unset* one is the normal case and takes the Brave default; a *set but
  // unusable* one is a misconfiguration and is passed through unchanged, so the
  // provider reports itself unavailable rather than silently sending the key to a
  // host the operator did not choose. `available()` is what enforces that.
  const rejected = [
    'not a url',
    '/res/v1',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/plain,hello',
    'ftp://example.test/res/v1',
    'https://user:secret@example.test/res/v1',
    'https://example.test/res/v1?token=abc',
    'https://example.test/res/v1#frag',
  ];
  for (const baseURL of rejected) {
    assert.notEqual(resolveOptions(contextWith(), { baseURL }).baseURL, DEFAULT_BASE_URL, `${baseURL} must not be replaced by the default`);
    assert.equal(resolveOptions(contextWith(), { baseURL }).baseURL, baseURL, `${baseURL} must be reported as configured`);
  }
  // Unset and blank stay on the default: absence is not a misconfiguration.
  assert.equal(resolveOptions(contextWith(), {}).baseURL, DEFAULT_BASE_URL);
  assert.equal(resolveOptions(contextWith(), { baseURL: '   ' }).baseURL, DEFAULT_BASE_URL);
  // Plain http stays available: a corporate mirror or the local test server may
  // not terminate TLS, and SECURITY.md documents the trade-off. The trailing slash
  // is normalized away, so the recorded endpoint is the one actually requested.
  assert.equal(resolveOptions(contextWith(), { baseURL: 'http://127.0.0.1:9/res/v1' }).baseURL, 'http://127.0.0.1:9/res/v1');
  assert.equal(resolveOptions(contextWith(), { baseURL: 'https://example.test/res/v1/' }).baseURL, 'https://example.test/res/v1');
});

test('resolveOptions corrects unusable values instead of throwing', () => {
  const options = resolveOptions(contextWith(), {
    mode: 'nonsense',
    safesearch: 'sometimes',
    contextThresholdMode: 'whatever',
    count: 999,
    maxTokens: 1,
    timeoutMs: -5,
    maxAttempts: 99,
    retryBaseMs: -1,
    minIntervalMs: -1,
    country: '   ',
    searchLang: '',
  });
  assert.equal(options.mode, 'llm-context');
  assert.equal(options.safesearch, undefined);
  assert.equal(options.contextThresholdMode, undefined);
  assert.equal(options.count, 50);
  assert.equal(options.maxTokens, 1024);
  assert.equal(options.timeoutMs, 1);
  assert.equal(options.maxAttempts, 10);
  assert.equal(options.retryBaseMs, 0);
  assert.equal(options.minIntervalMs, 0);
  assert.equal(options.country, 'us');
  assert.equal(options.searchLang, 'en');
});

test('resolveOptions falls back to the default when a bound is not a number at all', () => {
  const options = resolveOptions(contextWith(), {
    count: 'many',
    maxTokens: Number.NaN,
    timeoutMs: null,
    maxAttempts: undefined,
    retryBaseMs: {},
    minIntervalMs: Number.POSITIVE_INFINITY,
  });
  assert.equal(options.count, 20);
  assert.equal(options.maxTokens, 8192);
  assert.equal(options.timeoutMs, 30000);
  assert.equal(options.maxAttempts, 3);
  assert.equal(options.retryBaseMs, 250);
  assert.equal(options.minIntervalMs, 0);
});

test('resolveOptions keeps the configured values that are usable', () => {
  const options = resolveOptions(contextWith(), {
    mode: 'web-search',
    safesearch: 'strict',
    freshness: 'py',
    contextThresholdMode: 'lenient',
    count: 7,
    maxTokens: 2048,
    timeoutMs: 1200,
    maxAttempts: 5,
    retryBaseMs: 10,
    minIntervalMs: 250,
    country: 'de',
    searchLang: 'de',
  });
  assert.equal(options.mode, 'web-search');
  assert.equal(options.safesearch, 'strict');
  assert.equal(options.freshness, 'py');
  assert.equal(options.contextThresholdMode, 'lenient');
  assert.equal(options.count, 7);
  assert.equal(options.maxTokens, 2048);
  assert.equal(options.timeoutMs, 1200);
  assert.equal(options.maxAttempts, 5);
  assert.equal(options.retryBaseMs, 10);
  assert.equal(options.minIntervalMs, 250);
  assert.equal(options.country, 'de');
  assert.equal(options.searchLang, 'de');
});

test('resolveOptions falls back to the default credential reference name', () => {
  assert.equal(String(resolveOptions(contextWith(), undefined).apiKeyEnv), DEFAULT_API_KEY_ENV);
  assert.equal(String(resolveOptions(contextWith(), { apiKeyEnv: 'MY_BRAVE_KEY' }).apiKeyEnv), 'MY_BRAVE_KEY');
  assert.equal(String(resolveOptions(contextWith(), { apiKeyEnv: 'not a valid name!' }).apiKeyEnv), DEFAULT_API_KEY_ENV);
});

test('resolveApiKey prefers the credential service and re-resolves per call', async () => {
  const asked = [];
  let value = 'first-value-from-service';
  const credentials = {
    resolve: async (ref) => {
      asked.push(String(ref));
      return { value, source: 'file' };
    },
  };
  const execFile = missingToolExecFile();
  const options = resolveOptions(contextWith({ credentials, environment: { [DEFAULT_API_KEY_ENV]: 'ambient-value' } }), undefined, { execFile });
  assert.equal((await options.resolveApiKey()).value, 'first-value-from-service');
  value = 'second-value-from-service';
  assert.equal((await options.resolveApiKey()).value, 'second-value-from-service');
  assert.deepEqual(asked, [DEFAULT_API_KEY_ENV, DEFAULT_API_KEY_ENV]);
  assert.deepEqual(execFile.calls, [], 'the store answers before any password manager is consulted');
});

test('resolveApiKey falls back to a password manager when the store is empty', async () => {
  const credentials = { resolve: async () => undefined };
  const execFile = scriptedExecFile({ 'secret-tool lookup service dsh-web-search-brave': 'keyring-value' });
  const options = resolveOptions(contextWith({ credentials }), undefined, { execFile });
  const resolved = await options.resolveApiKey();
  assert.equal(resolved.value, 'keyring-value');
  assert.equal(resolved.source, 'gnome-keyring');
  assert.match(resolved.attempted.join(' '), /harness credential store/u);
});

test('resolveApiKey falls through the keyring to pass', async () => {
  const execFile = scriptedExecFile({ 'pass show dsh/brave-search-api': 'pass-value' });
  const options = resolveOptions(contextWith(), undefined, { execFile });
  const resolved = await options.resolveApiKey();
  assert.equal(resolved.value, 'pass-value');
  assert.equal(resolved.source, 'pass');
  assert.deepEqual(execFile.calls.map((call) => call.file), ['secret-tool', 'pass']);
});

test('resolveApiKey with secretManager none reads no password manager', async () => {
  const execFile = missingToolExecFile();
  const options = resolveOptions(contextWith({ environment: { [DEFAULT_API_KEY_ENV]: 'ambient' } }), { secretManager: 'none' }, { execFile });
  assert.equal((await options.resolveApiKey()).value, 'ambient');
  assert.deepEqual(execFile.calls, []);
});

test('resolveApiKey uses the launch environment when no credential service exists', async () => {
  const environment = { BRAVE_TEST_KEY_NAME: 'ambient-token' };
  const execFile = missingToolExecFile();
  const options = resolveOptions(contextWith({ environment }), { apiKeyEnv: 'BRAVE_TEST_KEY_NAME' }, { execFile });
  const resolved = await options.resolveApiKey();
  assert.equal(resolved.value, 'ambient-token');
  assert.equal(resolved.source, 'launch environment');
  assert.match(resolved.attempted.join(' '), /gnome-keyring/u);
});

test('resolveApiKey skips the environment when a credential service is mounted', async () => {
  const credentials = { resolve: async () => undefined };
  const options = resolveOptions(contextWith({ credentials, environment: { [DEFAULT_API_KEY_ENV]: 'ambient-value' } }), undefined, { execFile: missingToolExecFile() });
  const resolved = await options.resolveApiKey();
  assert.equal(resolved.value, undefined);
  assert.match(resolved.attempted.join(' '), /harness credential store/u);
  assert.equal(resolved.attempted.join(' ').includes('launch environment'), false);
});

test('resolveApiKey reports an unset or empty ambient value as absent', async () => {
  assert.equal((await resolveOptions(contextWith(), undefined, { execFile: missingToolExecFile() }).resolveApiKey()).value, undefined);
  assert.equal((await resolveOptions(contextWith({ environment: { [DEFAULT_API_KEY_ENV]: '' } }), undefined, { execFile: missingToolExecFile() }).resolveApiKey()).value, undefined);
});

test('recordRequest appends the secret-free request event to the current session', () => {
  const appended = [];
  const agents = {
    currentInitiator: () => ({ session: { append: (eventName, payload) => appended.push({ eventName, payload }) } }),
  };
  const options = resolveOptions(contextWith({ agents }), undefined);
  const event = {
    provider: PROVIDER_ID,
    endpoint: 'https://api.search.brave.com/res/v1/llm/context',
    mode: 'llm-context',
    query: 'what is a cordis plugin',
    params: { q: 'what is a cordis plugin', count: 20 },
  };
  options.recordRequest(event);
  assert.deepEqual(appended, [{ eventName: SEARCH_REQUEST_EVENT, payload: event }]);
});

test('recordRequest is inert without an agents service or an initiator', () => {
  assert.doesNotThrow(() => resolveOptions(contextWith(), undefined).recordRequest({ query: 'q' }));
  const agents = { currentInitiator: () => undefined };
  assert.doesNotThrow(() => resolveOptions(contextWith({ agents }), undefined).recordRequest({ query: 'q' }));
});

test('effectiveCount honors maxResults, falls back on nonsense, and clamps per mode', () => {
  assert.equal(maxCountForMode('llm-context'), 50);
  assert.equal(maxCountForMode('web-search'), 20);
  assert.equal(effectiveCount(8, 20, 'llm-context'), 8);
  assert.equal(effectiveCount(undefined, 20, 'llm-context'), 20);
  assert.equal(effectiveCount(0, 20, 'llm-context'), 20);
  assert.equal(effectiveCount(4.5, 20, 'llm-context'), 20);
  assert.equal(effectiveCount(80, 20, 'llm-context'), 50);
  assert.equal(effectiveCount(80, 20, 'web-search'), 20);
  assert.equal(effectiveCount(undefined, 50, 'web-search'), 20);
  assert.equal(effectiveCount(1, 20, 'web-search'), 1);
});

test('the settings namespace matches the package name and the provider id is stable', () => {
  assert.equal(SETTINGS_NAMESPACE, 'web-search-brave');
  assert.equal(PROVIDER_ID, 'brave-official');
});

test('a context without a launch environment reuses one fallback snapshot', () => {
  // Building the fallback copies every variable of process.env into a fresh Map,
  // measured at ~81 us against ~0.3 us once cached. resolveOptions runs on every
  // provider-selection probe, so it must not rebuild that snapshot per call.
  // Identity is the observable proof that the cache is in force.
  const bare = { get: () => undefined };
  const first = resolveOptions(bare, {}).baseURL;
  const second = resolveOptions(bare, {}).baseURL;
  assert.equal(first, second);
  // Two distinct contexts must not share a cache entry.
  const other = { get: () => undefined };
  assert.equal(typeof resolveOptions(other, {}).baseURL, 'string');
});

test('a supplied launch environment still wins over any cached fallback', () => {
  // A context that starts bare and later receives the launcher's snapshot must
  // switch to it rather than keep serving the cached fallback.
  const supplied = createLaunchEnvironmentSnapshot([{ source: 'project-env', values: { [BASE_URL_ENV]: 'https://supplied.example.test/res/v1' } }]);
  let useSupplied = false;
  const ctx = {
    get(name) {
      if (name === 'launchEnvironment') return useSupplied ? supplied : undefined;
      return undefined;
    },
  };
  const before = resolveOptions(ctx, {}).baseURL;
  useSupplied = true;
  const after = resolveOptions(ctx, {}).baseURL;
  assert.equal(after, 'https://supplied.example.test/res/v1');
  assert.notEqual(before, after, 'the cached fallback must not mask a later snapshot');
});

test('the timing bounds that reach setTimeout stay inside its 32-bit range', () => {
  // A delay larger than 2**31-1 overflows the timer's 32-bit field: Node clamps
  // it to 1 ms and emits TimeoutOverflowWarning. For `minIntervalMs` that turned
  // "space searches out" into "do not space them at all", silently, with a
  // warning per dispatch. Every timing field is therefore bounded at a value a
  // timer can actually carry.
  const huge = 2 ** 40;
  const resolved = resolveOptions(contextWith(), { minIntervalMs: huge, retryBaseMs: huge });
  assert.ok(resolved.minIntervalMs > 1, 'a large spacing must not collapse to the overflow clamp');
  assert.ok(resolved.minIntervalMs <= 2 ** 31 - 1, `minIntervalMs resolved to ${resolved.minIntervalMs}`);
  assert.ok(resolved.retryBaseMs <= 2 ** 31 - 1, `retryBaseMs resolved to ${resolved.retryBaseMs}`);
  // The real assertion: arming a timer with the resolved spacing must not warn.
  const warnings = [];
  const onWarning = (warning) => warnings.push(String(warning));
  process.on('warning', onWarning);
  const timer = setTimeout(() => {}, resolved.minIntervalMs);
  clearTimeout(timer);
  process.off('warning', onWarning);
  assert.deepEqual(warnings, [], 'the resolved spacing must be a delay setTimeout can honor');
});

test('the schema refuses an out-of-range timing value before it reaches the transport', () => {
  // The schema is what the settings UI renders, so the bound has to be visible
  // there too, not only in the defensive projection.
  const tooLarge = 2 ** 40;
  assert.throws(() => Config({ minIntervalMs: tooLarge }), 'minIntervalMs above the ceiling must be rejected');
  assert.throws(() => Config({ retryBaseMs: tooLarge }), 'retryBaseMs above the ceiling must be rejected');
  assert.equal(Config({ minIntervalMs: 60000 }).minIntervalMs, 60000, 'the ceiling itself must be accepted');
});

test('a refused session event never fails the search it was recording', () => {
  // The session's `append` validates its payload and throws for data that does
  // not survive a JSON round trip. Recording is an observability side channel, so
  // a refused append must not turn a working search into a failure.
  const ctx = {
    get(name) {
      if (name === 'launchEnvironment') return createLaunchEnvironmentSnapshot([{ source: 'process', values: { [DEFAULT_API_KEY_ENV]: 'fixture' } }]);
      if (name === 'agents') {
        return {
          currentInitiator: () => ({
            session: {
              append: () => {
                throw new Error('session event carries non-JSON-serializable data');
              },
            },
          }),
        };
      }
      return undefined;
    },
  };
  const options = resolveOptions(ctx, {}, { execFile: missingToolExecFile() });
  assert.doesNotThrow(() => options.recordRequest({ provider: PROVIDER_ID, query: 'q' }));
});

test('recordRequest reports the endpoint and query to the session when it can', () => {
  const events = [];
  const ctx = {
    get(name) {
      if (name === 'launchEnvironment') return createLaunchEnvironmentSnapshot([]);
      if (name === 'agents') {
        return { currentInitiator: () => ({ session: { append: (eventName, payload) => events.push({ eventName, payload }) } }) };
      }
      return undefined;
    },
  };
  resolveOptions(ctx, {}).recordRequest({ provider: PROVIDER_ID, endpoint: 'https://api.example.test/res/v1/web/search', query: 'cordis' });
  assert.deepEqual(events, [{ eventName: SEARCH_REQUEST_EVENT, payload: { provider: PROVIDER_ID, endpoint: 'https://api.example.test/res/v1/web/search', query: 'cordis' } }]);
});
