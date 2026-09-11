// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Transport for the Brave Search API: URL construction, one GET with a
 * per-attempt timeout, bounded retries with exponential backoff, and an optional
 * client-side throttle that serializes dispatch.
 *
 * Design points worth knowing before changing anything here:
 *
 * - `redirect: 'error'` — a redirect is rejected before the target is contacted,
 *   so a compromised or misconfigured base URL cannot bounce a request carrying
 *   the subscription header somewhere else.
 * - The caller's signal and our timeout are combined with `AbortSignal.any`, and
 *   the two outcomes stay distinguishable: the caller's abort raises
 *   `WEB_ABORTED`, our timeout raises `WEB_PROVIDER_ERROR` naming the timeout.
 * - The subscription token travels only in the `X-Subscription-Token` header. It
 *   never enters the URL, a log line, an error message, or the recorded request
 *   event; transport-level diagnostics are redacted before they are surfaced.
 * - `accept-encoding` is deliberately not set, so Node's fetch negotiates
 *   decompression itself.
 *
 * @module dsh-web-search-brave/client
 */
import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_TIMEOUT_MS,
  LLM_CONTEXT_PATH,
  MAX_MAX_ATTEMPTS,
  MAX_TIMEOUT_MS,
  MIN_MAX_ATTEMPTS,
  MIN_TIMEOUT_MS,
  MODE_WEB_SEARCH,
  USER_AGENT,
  WEB_SEARCH_PATH,
  clampInteger,
  effectiveCount,
} from './config.js';
import {
  credentialMissingError,
  describeError,
  isAbortError,
  providerError,
  redact,
  searchAborted,
  throwIfSearchAborted,
} from './errors.js';

/** Longest `Retry-After` this client will honor, so one hostile header cannot stall a search. */
export const MAX_RETRY_AFTER_MS = 60000;
/** Longest computed backoff delay. */
export const MAX_RETRY_DELAY_MS = 30000;
/** Longest Brave error detail copied into a message. */
export const MAX_ERROR_DETAIL_LENGTH = 300;
/**
 * Header carrying the subscription token. It is the one and only place the key
 * leaves this plugin, and it is deliberately not spelled out at the assignment
 * site so no configuration file, log line, or fixture can copy the pattern.
 */
export const SUBSCRIPTION_TOKEN_HEADER = 'x-subscription-token';

/**
 * Append an endpoint path to a base URL, tolerating trailing slashes.
 * @param baseURL - the configured API base.
 * @param path - the endpoint path, with a leading slash.
 * @returns the endpoint URL.
 */
export function joinUrl(baseURL, path) {
  return `${String(baseURL).replace(/\/+$/u, '')}${path}`;
}

/**
 * Build one search's endpoint and non-secret query parameters. Parameters whose
 * configuration is unset are omitted rather than sent empty, so Brave's own
 * default stays in force.
 * @param options - the resolved provider options.
 * @param request - the query and optional result bound.
 * @returns the endpoint and the ordered, JSON-safe parameters.
 */
export function buildQuery(options, request) {
  const mode = options.mode;
  const count = effectiveCount(request.maxResults, options.count, mode);
  const params = {
    q: request.query,
    country: options.country,
    search_lang: options.searchLang,
    count,
  };
  if (options.freshness !== undefined) params.freshness = options.freshness;
  if (options.safesearch !== undefined) params.safesearch = options.safesearch;
  if (mode === MODE_WEB_SEARCH) {
    params.text_decorations = 'false';
    params.result_filter = 'web';
    return { endpoint: joinUrl(options.baseURL, WEB_SEARCH_PATH), params };
  }
  params.maximum_number_of_urls = count;
  params.maximum_number_of_tokens = options.maxTokens;
  if (options.contextThresholdMode !== undefined) params.context_threshold_mode = options.contextThresholdMode;
  return { endpoint: joinUrl(options.baseURL, LLM_CONTEXT_PATH), params };
}

/**
 * Render an endpoint and its parameters as a request URL.
 * @param endpoint - the endpoint URL.
 * @param params - the query parameters.
 * @returns the URL, with every value percent-encoded.
 */
export function buildUrl(endpoint, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length === 0 ? endpoint : `${endpoint}?${query}`;
}

/**
 * Parse a `Retry-After` header value in either of its two legal forms: a delay
 * in seconds, or an HTTP date.
 * @param value - the raw header value.
 * @param nowMs - the current epoch time, for the date form.
 * @returns the delay in milliseconds, or `undefined` when the header is absent,
 *   unparseable, or in the past.
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/u.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, Math.min(when - nowMs, MAX_RETRY_AFTER_MS));
}

/**
 * Delay before the next attempt: the server's `Retry-After` when it sent one,
 * otherwise `retryBaseMs` doubled once per failed attempt.
 * @param attempt - the 1-based number of the attempt that just failed.
 * @param retryAfterMs - the parsed `Retry-After`, when there was one.
 * @param retryBaseMs - the configured backoff base.
 * @returns the delay in milliseconds.
 */
export function retryDelayMs(attempt, retryAfterMs, retryBaseMs) {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)) return Math.max(0, retryAfterMs);
  const base = typeof retryBaseMs === 'number' && Number.isFinite(retryBaseMs) && retryBaseMs > 0 ? retryBaseMs : 0;
  return Math.min(base * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

/**
 * Whether a status is worth another attempt: rate limiting, a request timeout,
 * or any server-side failure. Other 4xx responses fail identically on every
 * attempt and are never retried.
 * @param status - the HTTP status.
 * @returns true when the request may be repeated.
 */
export function isRetryableStatus(status) {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

/**
 * Whether a caught fetch rejection came from refusing a redirect. Those are not
 * transient: repeating the request would be refused again.
 * @param error - the caught value.
 * @returns true when the message names a redirect.
 */
export function isRedirectError(error) {
  const parts = [error instanceof Error ? error.message : '', error?.cause instanceof Error ? error.cause.message : ''];
  return parts.some((part) => part.toLowerCase().includes('redirect'));
}

/**
 * Sleep, honoring cancellation. The backoff between attempts is abortable, so a
 * cancelled search never waits out a timeout it no longer needs.
 * @param ms - the delay in milliseconds.
 * @param signal - the caller's signal, when one was supplied.
 * @returns a promise settling after the delay.
 */
export function sleepMs(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal !== undefined && signal.aborted === true) {
      reject(searchAborted(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(searchAborted(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Serializes dispatch through a promise chain, so concurrent searches cannot
 * race each other, and enforces a minimum spacing between the starts of two
 * consecutive ones. With `minIntervalMs` of 0 the chain still serializes, which
 * is what keeps the spacing decision consistent under concurrency.
 */
export class RequestThrottle {
  /** Tail of the chain; always settled, so one failure never poisons the queue. */
  #tail = Promise.resolve();
  /** Start time of the most recent dispatch, in milliseconds. */
  #lastStart = Number.NEGATIVE_INFINITY;
  /** Clock seam, injectable for tests. */
  #now;

  /**
   * @param options - optional `now` clock override.
   */
  constructor(options = {}) {
    this.#now = options.now ?? Date.now;
  }

  /**
   * Queue one dispatch behind every previously queued one.
   * @param operation - the dispatch to run when its turn arrives.
   * @param options - the spacing to enforce and the caller's cancellation signal.
   * @returns the operation's own result.
   */
  schedule(operation, options = {}) {
    const minIntervalMs = typeof options.minIntervalMs === 'number' && Number.isFinite(options.minIntervalMs) ? Math.max(0, options.minIntervalMs) : 0;
    const signal = options.signal;
    const sleep = options.sleep ?? sleepMs;
    const run = this.#tail.then(async () => {
      throwIfSearchAborted(signal);
      const wait = minIntervalMs - (this.#now() - this.#lastStart);
      if (wait > 0) await sleep(wait, signal);
      this.#lastStart = this.#now();
      return operation();
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Build the timeout failure, naming the limit so a user can raise it. */
function timeoutError(url, timeoutMs, secrets, cause) {
  return providerError(`Brave search timed out after ${timeoutMs} ms waiting for ${url}`, { cause, secrets });
}

/** Collapse and truncate a response body for a diagnostic message. */
function summarize(text, secrets) {
  return redact(String(text).replace(/\s+/gu, ' ').trim().slice(0, MAX_ERROR_DETAIL_LENGTH), secrets);
}

/** Brave's error detail, from whichever envelope field the response used. */
function extractErrorDetail(parsed, secrets) {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const candidates = [parsed.error?.detail, parsed.error?.message, typeof parsed.error === 'string' ? parsed.error : undefined, parsed.detail, parsed.message];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return summarize(candidate, secrets);
  }
  return undefined;
}

/** Best-effort Brave error detail for an unsuccessful response; never throws on body issues. */
async function readErrorDetail(response, secrets, signal, timeoutSignal) {
  let text;
  try {
    text = await response.text();
  } catch (error) {
    if (signal !== undefined && signal.aborted === true) throw searchAborted(signal, error);
    if (timeoutSignal.aborted) return '';
    return '';
  }
  if (text.trim().length === 0) return undefined;
  let detail;
  try {
    detail = extractErrorDetail(JSON.parse(text), secrets);
  } catch {
    detail = undefined;
  }
  return detail ?? summarize(text, secrets);
}

/** Parse a successful response body, classifying an unusable body as a provider error. */
async function readPayload(response, url, secrets, signal, timeoutSignal, timeoutMs) {
  let body;
  try {
    body = await response.text();
  } catch (error) {
    if (signal !== undefined && signal.aborted === true) throw searchAborted(signal, error);
    if (timeoutSignal.aborted) throw timeoutError(url, timeoutMs, secrets, error);
    throw providerError(`Brave search response body could not be read: ${describeError(error, secrets)}`, { cause: error, secrets });
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw providerError(`Brave search returned a body that was not JSON (HTTP ${response.status}): ${summarize(body, secrets)}`, { cause: error, secrets });
  }
}

/**
 * Perform one search request, retrying retryable failures up to
 * `options.maxAttempts` times. One attempt is one GET with its own timeout: a
 * retry never inherits a partially elapsed deadline.
 * @param input - the URL, the resolved key, the resolved options, and the
 *   caller's signal.
 * @returns the parsed response body.
 * @throws {WebError} `WEB_ABORTED` when the caller cancelled,
 *   `WEB_PROVIDER_CREDENTIAL_MISSING` when no key reached the transport, and
 *   `WEB_PROVIDER_ERROR` for every other failure.
 */
export async function fetchSearch(input) {
  const { url, apiKey, options, signal } = input;
  const deps = input.deps ?? {};
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? sleepMs;
  const now = deps.now ?? Date.now;
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw credentialMissingError(options.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
  const secrets = [apiKey];
  const attempts = clampInteger(options.maxAttempts, MIN_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
  const timeoutMs = clampInteger(options.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const headers = { accept: 'application/json', 'user-agent': USER_AGENT };
  headers[SUBSCRIPTION_TOKEN_HEADER] = apiKey;
  for (let attempt = 1; ; attempt += 1) {
    throwIfSearchAborted(signal);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers,
        signal: requestSignal,
      });
    } catch (error) {
      if (signal !== undefined && signal.aborted === true) throw searchAborted(signal, error);
      if (timeoutSignal.aborted) throw timeoutError(url, timeoutMs, secrets, error);
      if (isAbortError(error)) throw providerError(`Brave search request was aborted before a response arrived`, { cause: error, secrets });
      if (isRedirectError(error)) throw providerError(`Brave search refused an HTTP redirect from ${url}: ${describeError(error, secrets)}`, { cause: error, secrets });
      if (attempt >= attempts) throw providerError(`Brave search request to ${url} failed after ${attempt} attempt(s): ${describeError(error, secrets)}`, { cause: error, secrets });
      await sleep(retryDelayMs(attempt, undefined, options.retryBaseMs), signal);
      continue;
    }
    if (response.ok) return await readPayload(response, url, secrets, signal, timeoutSignal, timeoutMs);
    const detail = await readErrorDetail(response, secrets, signal, timeoutSignal);
    if (isRetryableStatus(response.status) && attempt < attempts) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
      await sleep(retryDelayMs(attempt, retryAfterMs, options.retryBaseMs), signal);
      continue;
    }
    throw providerError(`Brave search API error (HTTP ${response.status})${detail === undefined ? '' : `: ${detail}`}`, { secrets });
  }
}
