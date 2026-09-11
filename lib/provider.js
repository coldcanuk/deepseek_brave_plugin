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
  MAX_MIN_INTERVAL_MS,
  MAX_RETRY_BASE_MS,
  MAX_TIMEOUT_MS,
  MIN_COUNT,
  MIN_MAX_ATTEMPTS,
  MIN_TIMEOUT_MS,
  MODES,
  PROVIDER_ID,
} from './config.js';
import { abortable, credentialMissingError, providerError, safeCredentialLabel, searchAborted, throwIfSearchAborted } from './errors.js';
import { mapResponse } from './map.js';

/** True when a value is an integer inside an inclusive range. */
function inIntegerRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Whether a base URL is one the transport can send a credential to. The key
 * rides in a request header, so a non-HTTP scheme is never a search endpoint,
 * and credentials, a query string, or a fragment each either leak a secret into
 * the recorded event or break the endpoint path that gets appended.
 * @param value - the resolved base URL.
 * @returns true when the value is an absolute http(s) URL with a bare path.
 */
function isUsableBaseUrl(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const parsed = new URL(value);
  return (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0
  );
}

/**
 * Whether a fully resolved option set is usable. Local and cheap by
 * construction: no credential is consulted, because a missing key is judged at
 * search time against a freshly resolved reference, and reporting it here would
 * make a keyless provider invisible to the seam instead of failing with a
 * fixable `WEB_PROVIDER_CREDENTIAL_MISSING`.
 *
 * Reporting `false` is the safe outcome for a bad value: the seam then treats
 * this provider as unavailable rather than dispatching a request with a
 * credential to a host the operator did not intend.
 * @param options - the resolved options.
 * @returns true when the base URL is a bare http(s) URL and every numeric bound is sane.
 */
export function optionsAreUsable(options) {
  if (options === null || typeof options !== 'object') return false;
  return (
    isUsableBaseUrl(options.baseURL) &&
    MODES.includes(options.mode) &&
    inIntegerRange(options.count, MIN_COUNT, MAX_COUNT) &&
    inIntegerRange(options.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) &&
    inIntegerRange(options.maxAttempts, MIN_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS) &&
    inIntegerRange(options.retryBaseMs, 0, MAX_RETRY_BASE_MS) &&
    inIntegerRange(options.minIntervalMs, 0, MAX_MIN_INTERVAL_MS)
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
   * @param deps - optional `fetchImpl`, `sleep`, `now`, and `execFile` seams for tests.
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
      options = this.#resolveOptions(this.#deps);
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
    const options = this.#resolveOptions(this.#deps);
    throwIfSearchAborted(signal);
    // Validate the query before anything else: an absent or non-string query would
    // otherwise be sent as `q=undefined`, which is a caller error rather than a
    // provider fault. Anything JSON-safe that arrives past this point is recorded
    // by the guarded call below, so a refused event cannot fail a search.
    const query = request?.query;
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw providerError('Brave search needs a non-empty string query; the request carried none.');
    }
    const apiKey = await this.#apiKey(options, signal);
    throwIfSearchAborted(signal);
    const { endpoint, params } = buildQuery(options, request);
    // Recording is an observability side channel, never a gate on the search. This
    // is the second layer of that guarantee: `resolveOptions` already contains a
    // refusing `session.append`, but a caller-supplied `recordRequest` seam can
    // still throw, and an unwritable log must not turn a working search into a
    // failure.
    try {
      options.recordRequest?.({
        provider: this.id,
        endpoint,
        mode: options.mode,
        query,
        params,
      });
    } catch {
      // Deliberately ignored: see above.
    }
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
   * @param signal - abort signal for the surrounding search; it also cancels a hung secret-manager lookup.
   * @returns the resolved key.
   * @throws {WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when nothing resolves, carrying what was tried.
   */
  async #apiKey(options, signal) {
    throwIfSearchAborted(signal);
    let resolved;
    try {
      resolved = await abortable(options.resolveApiKey?.(signal) ?? Promise.resolve(undefined), signal);
    } catch (error) {
      if (signal !== undefined && signal.aborted === true) throw searchAborted(signal, error);
      // No `secrets` list exists on this path — resolution is what failed — so the
      // message must not be trusted to be secret-free on its own. The credential
      // reference is passed through the same label helper the missing-key message
      // uses, and the underlying error is reduced to its name, so a credential
      // provider that quotes a value in its own message cannot surface it here.
      throw providerError(
        `Brave search credential resolution failed for ${safeCredentialLabel(options.apiKeyEnv)} (${error instanceof Error ? error.name : typeof error})`,
        { cause: error },
      );
    }
    if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) return resolved.value;
    throw credentialMissingError(options.apiKeyEnv, resolved?.attempted);
  }
}
