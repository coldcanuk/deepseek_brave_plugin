// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Plugin entry contract: the exports the loader reads, the provider registration
 * `apply` performs, and the settings wiring that lets a live settings section
 * replace the composition entry without re-registering the provider.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { Config, DEFAULT_API_KEY_ENV, PROVIDER_ID, SETTINGS_NAMESPACE, apply, inject, name } from '../lib/index.js';
import { llmContextBody, startMockBrave } from './helpers/mock-brave.js';

/** An obvious fixture, never a usable credential. */
const SUBSCRIPTION_TOKEN = 'brave-fixture-value-not-a-real-credential';

/** The smallest host that satisfies `apply`: a web registry and an optional settings service. */
function fakeHost({ settings } = {}) {
  const registered = [];
  const injected = [];
  const installed = [];
  const snapshot = createLaunchEnvironmentSnapshot([{ source: 'process', values: { [DEFAULT_API_KEY_ENV]: SUBSCRIPTION_TOKEN } }]);
  const ctx = {
    web: {
      registerSearchProvider(provider) {
        registered.push(provider);
        return () => {};
      },
    },
    inject(deps, callback) {
      injected.push(deps);
      if (settings !== undefined) callback({ settings });
    },
    get(service) {
      return service === 'launchEnvironment' ? snapshot : undefined;
    },
  };
  return { ctx, registered, injected, installed };
}

/** A settings service stand-in that records the installed section and its hooks. */
function fakeSettings(installed) {
  return {
    installSection(owner, ns, schema, entry, hooks) {
      installed.push({ owner, ns, schema, entry, hooks });
    },
  };
}

test('the entry exports the cordis plugin contract exactly', () => {
  assert.equal(name, 'web-search-brave');
  assert.deepEqual(inject, ['web']);
  assert.equal(typeof apply, 'function');
  assert.equal(typeof Config, 'function');
  assert.equal(PROVIDER_ID, 'brave-official');
  assert.equal(SETTINGS_NAMESPACE, 'web-search-brave');
});

test('apply() registers one brave-official provider that satisfies the seam interface', async (t) => {
  const host = fakeHost();
  apply(host.ctx, { baseURL: 'https://api.search.brave.com/res/v1' });
  assert.equal(host.registered.length, 1);
  const provider = host.registered[0];
  assert.equal(provider.id, PROVIDER_ID);
  assert.equal(typeof provider.available, 'function');
  assert.equal(typeof provider.search, 'function');
  assert.equal(provider.available(), true);
  assert.deepEqual(host.injected, [['settings']]);
  assert.equal(host.installed.length, 0);
  t.diagnostic('registration succeeded without a settings service');
});

test('apply() installs the settings section with this plugin namespace and schema', () => {
  const installed = [];
  const host = fakeHost({ settings: fakeSettings(installed) });
  const entry = { baseURL: 'https://api.search.brave.com/res/v1', count: 5 };
  apply(host.ctx, entry);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].owner, host.ctx);
  assert.equal(installed[0].ns, SETTINGS_NAMESPACE);
  assert.equal(installed[0].schema, Config);
  assert.equal(installed[0].entry, entry);
  assert.equal(typeof installed[0].hooks.setSource, 'function');
  assert.equal(typeof installed[0].hooks.onChange, 'function');
});

test('a settings source replaces the composition entry for subsequent searches', () => {
  const installed = [];
  const host = fakeHost({ settings: fakeSettings(installed) });
  apply(host.ctx, { baseURL: 'https://api.search.brave.com/res/v1' });
  const provider = host.registered[0];
  assert.equal(provider.available(), true);
  installed[0].hooks.setSource(() => ({ baseURL: 'not a url' }));
  assert.equal(provider.available(), false);
  installed[0].hooks.setSource(() => ({ baseURL: 'https://api.search.brave.com/res/v1' }));
  assert.equal(provider.available(), true);
});

test('the registered provider searches the configured base URL end to end', async (t) => {
  const server = await startMockBrave();
  t.after(() => server.close());
  server.json(llmContextBody({ generic: [{ url: 'https://example.test/a', title: 'A', snippets: ['chunk'] }] }));
  const host = fakeHost();
  apply(host.ctx, { baseURL: server.baseURL, mode: 'llm-context' });
  const result = await host.registered[0].search({ query: 'cordis', maxResults: 3 });
  assert.deepEqual(result.sources, [{ url: 'https://example.test/a', title: 'A', snippet: 'chunk' }]);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].params.q, 'cordis');
  assert.equal(server.requests[0].params.count, '3');
});

test('the package declares itself a profile bundle that dsh plugin add composes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch layer must ship in the tarball');
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml');
  const layer = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(layer, /^- insert:/m, 'the provider row must be inserted');
  assert.match(layer, /id: web-search-brave/);
  assert.match(layer, /name: '@coldcanuk\/dsh-web-search-brave'/);
  assert.match(layer, /searchProvider: brave-official/);
  assert.match(layer, /fetchProvider: http/);
  assert.doesNotMatch(layer, /apiKey\s*:/, 'the bundle layer must never carry a literal key field');
});
