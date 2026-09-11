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

/** Every field the README documents, and therefore every field the schema must carry. */
const DOCUMENTED_FIELDS = [
  'apiKeyEnv',
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
});

test('resolveOptions falls back to the environment for baseURL and lets config win', () => {
  const environment = { [BASE_URL_ENV]: 'http://127.0.0.1:9/res/v1/' };
  assert.equal(resolveOptions(contextWith({ environment }), undefined).baseURL, 'http://127.0.0.1:9/res/v1/');
  assert.equal(resolveOptions(contextWith({ environment }), { baseURL: 'https://example.test/res/v1' }).baseURL, 'https://example.test/res/v1');
  assert.equal(resolveOptions(contextWith({ environment: { [BASE_URL_ENV]: '   ' } }), undefined).baseURL, DEFAULT_BASE_URL);
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
  const options = resolveOptions(contextWith({ credentials, environment: { [DEFAULT_API_KEY_ENV]: 'ambient-value' } }), undefined);
  assert.equal(await options.resolveApiKey(), 'first-value-from-service');
  value = 'second-value-from-service';
  assert.equal(await options.resolveApiKey(), 'second-value-from-service');
  assert.deepEqual(asked, [DEFAULT_API_KEY_ENV, DEFAULT_API_KEY_ENV]);
});

test('resolveApiKey uses the launch environment when no credential service exists', async () => {
  const environment = { BRAVE_TEST_KEY_NAME: 'ambient-token' };
  const options = resolveOptions(contextWith({ environment }), { apiKeyEnv: 'BRAVE_TEST_KEY_NAME' });
  assert.equal(await options.resolveApiKey(), 'ambient-token');
});

test('resolveApiKey reports an unset or empty ambient value as absent', async () => {
  assert.equal(await resolveOptions(contextWith(), undefined).resolveApiKey(), undefined);
  assert.equal(await resolveOptions(contextWith({ environment: { [DEFAULT_API_KEY_ENV]: '' } }), undefined).resolveApiKey(), undefined);
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
