// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * The Brave-backed search provider registered with `ctx.web`.
 *
 * The provider is deliberately thin and stateless with respect to configuration:
 * it holds a thunk that resolves the options for the *next* operation, and it
 * snapshots those options exactly once at each `search()` entry. A settings
 * change therefore reaches the next search without re-registering the provider
 * (which would flicker the seam's provider selection), and one search can never
 * mix two settings revisions.
 *
 * The credential is resolved per search and never retained on the provider.
 *
 * @module dsh-web-search-brave/provider
 */
import { RequestThrottle, buildQuery, buildUrl, fetchSearch } from './client.js';
import {
  MAX_COUNT,
  MAX_MAX_ATTEMPTS,
  MAX_TIMEOUT_MS,
  MIN_COUNT,
  MIN_MAX_ATTEMPTS,
  MIN_TIMEOUT_MS,
  MODES,
  PROVIDER_ID,
} from './config.js';
import { abortable, credentialMissingError, describeError, providerError, searchAborted, throwIfSearchAborted } from './errors.js';
import { mapResponse } from './map.js';

/** True when a value is an integer inside an inclusive range. */
function inIntegerRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Whether a fully resolved option set is usable. Local and cheap by
 * construction: no credential is consulted, because a missing key is judged at
 * search time against a freshly resolved reference, and reporting it here would
 * make a keyless provider invisible to the seam instead of failing with a
 * fixable `WEB_PROVIDER_CREDENTIAL_MISSING`.
 * @param options - the resolved options.
 * @returns true when the base URL parses and every numeric bound is sane.
 */
export function optionsAreUsable(options) {
  if (options === null || typeof options !== 'object') return false;
  return (
    URL.canParse(options.baseURL) &&
    MODES.includes(options.mode) &&
    inIntegerRange(options.count, MIN_COUNT, MAX_COUNT) &&
    inIntegerRange(options.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) &&
    inIntegerRange(options.maxAttempts, MIN_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS) &&
    inIntegerRange(options.retryBaseMs, 0, Number.MAX_SAFE_INTEGER) &&
    inIntegerRange(options.minIntervalMs, 0, Number.MAX_SAFE_INTEGER)
  );
}

/** The Brave-backed search provider. */
export class BraveSearchProvider {
  /** Stable id this provider registers under. */
  id = PROVIDER_ID;

  /** Resolves the options for the next operation. */
  #resolveOptions;

  /** Serializes dispatch so concurrent searches cannot race Brave's rate window. */
  #throttle;

  /** Injectable transport seams, used by tests; empty in production. */
  #deps;

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once
   *   at each operation's entry.
   * @param deps - optional `fetchImpl`, `sleep`, and `now` seams for tests.
   */
  constructor(resolveOptions, deps = {}) {
    this.#resolveOptions = resolveOptions;
    this.#deps = deps;
    this.#throttle = new RequestThrottle({ now: deps.now });
  }

  /**
   * Cheap local check used by the seam for provider selection. Never performs a
   * network call and never throws.
   * @returns true when the resolved base URL parses and the numeric bounds are sane.
   */
  available() {
    let options;
    try {
      options = this.#resolveOptions();
    } catch {
      return false;
    }
    try {
      return optionsAreUsable(options);
    } catch {
      return false;
    }
  }

  /**
   * Run one search. Options are snapshotted here and reused for the whole
   * operation, including retries.
   * @param request - the query and optional result bound.
   * @param signal - optional cancellation signal.
   * @returns the normalized result.
   * @throws {WebError} `WEB_PROVIDER_CREDENTIAL_MISSING`, `WEB_ABORTED`, or
   *   `WEB_PROVIDER_ERROR`.
   */
  async search(request, signal) {
    const options = this.#resolveOptions();
    throwIfSearchAborted(signal);
    const apiKey = await this.#apiKey(options, signal);
    throwIfSearchAborted(signal);
    const { endpoint, params } = buildQuery(options, request);
    options.recordRequest?.({
      provider: this.id,
      endpoint,
      mode: options.mode,
      query: request.query,
      params,
    });
    throwIfSearchAborted(signal);
    const url = buildUrl(endpoint, params);
    return await this.#throttle.schedule(
      async () => mapResponse(options.mode, await fetchSearch({ url, apiKey, options, signal, deps: this.#deps })),
      { minIntervalMs: options.minIntervalMs, signal, sleep: this.#deps.sleep },
    );
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is
   *   sent to come from one settings revision.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key.
   * @throws {WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when nothing resolves.
   */
  async #apiKey(options, signal) {
    throwIfSearchAborted(signal);
    let resolved;
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal);
    } catch (error) {
      if (signal !== undefined && signal.aborted === true) throw searchAborted(signal, error);
      throw providerError(`Brave search credential resolution failed: ${describeError(error)}`, { cause: error });
    }
    if (typeof resolved === 'string' && resolved.length > 0) return resolved;
    throw credentialMissingError(options.apiKeyEnv);
  }
}
