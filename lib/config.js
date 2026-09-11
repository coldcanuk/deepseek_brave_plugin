// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Configuration surface and option resolution for the Brave search provider.
 *
 * Two layers live here on purpose:
 *
 * - {@link Config} is the schemastery schema a settings UI renders and the
 *   composition entry is validated against. It is deliberately free of any
 *   literal-key field: `apiKeyEnv` names a credential *reference*, and the value
 *   behind it is resolved per search through the harness credential seam.
 * - {@link resolveOptions} projects one authoritative config section into fully
 *   defaulted provider options, applying the environment fallbacks and numeric
 *   bounds in exactly one place so the provider never reads a partial value.
 *
 * The provider snapshots {@link resolveOptions} once per `search()`, so a single
 * search can never mix two settings revisions.
 *
 * @module dsh-web-search-brave/config
 */
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_GNOME_KEYRING_ATTRIBUTES,
  DEFAULT_PASS_PATH,
  SECRET_MANAGER_AUTO,
  SECRET_MANAGER_GNOME,
  SECRET_MANAGER_NONE,
  SECRET_MANAGER_PASS,
  SECRET_MANAGERS,
  resolveSecret,
  secretAttributes,
} from './secrets.js';
import { safeCredentialLabel } from './errors.js';

/** Settings namespace this plugin installs its section under. */
export const SETTINGS_NAMESPACE = 'web-search-brave';
/** Stable provider id registered with `ctx.web`. */
export const PROVIDER_ID = 'brave-official';
/** Session event recorded immediately before a Brave request is dispatched. */
export const SEARCH_REQUEST_EVENT = 'web/brave-search-request';

/** Default credential reference: the launch environment variable naming the key. */
export const DEFAULT_API_KEY_ENV = 'BRAVE_SEARCH_API_KEY';
/** Environment variable that overrides the API base. */
export const BASE_URL_ENV = 'BRAVE_SEARCH_BASE_URL';
/** Brave Search API base, `/res/v1` included; endpoint paths are appended. */
export const DEFAULT_BASE_URL = 'https://api.search.brave.com/res/v1';

/** Agent-oriented LLM Context endpoint. */
export const MODE_LLM_CONTEXT = 'llm-context';
/** Human-oriented Web Search results endpoint. */
export const MODE_WEB_SEARCH = 'web-search';
/** Every accepted `mode` value, in preference order. */
export const MODES = [MODE_LLM_CONTEXT, MODE_WEB_SEARCH];

/** Path of the LLM Context endpoint, appended to the base URL. */
export const LLM_CONTEXT_PATH = '/llm/context';
/** Path of the Web Search endpoint, appended to the base URL. */
export const WEB_SEARCH_PATH = '/web/search';

/** Accepted `safesearch` values. */
export const SAFESEARCH_VALUES = ['off', 'moderate', 'strict'];
/** Accepted `contextThresholdMode` values. */
export const CONTEXT_THRESHOLD_MODES = ['strict', 'balanced', 'lenient', 'disabled'];

/** Default mode when none is configured. */
export const DEFAULT_MODE = MODE_LLM_CONTEXT;
/** Default ISO 3166-1 alpha-2 country code for search results. */
export const DEFAULT_COUNTRY = 'us';
/** Default ISO 639-1 language code for search results. */
export const DEFAULT_SEARCH_LANG = 'en';

/** Smallest accepted result count. */
export const MIN_COUNT = 1;
/** Largest result count `llm-context` accepts. */
export const MAX_COUNT_LLM_CONTEXT = 50;
/** Largest result count `web-search` accepts. Brave rejects anything above 20. */
export const MAX_COUNT_WEB_SEARCH = 20;
/** Largest result count the schema admits; per-mode clamping happens later. */
export const MAX_COUNT = MAX_COUNT_LLM_CONTEXT;
/** Default result count. */
export const DEFAULT_COUNT = 20;

/** Smallest accepted LLM Context token budget. */
export const MIN_MAX_TOKENS = 1024;
/** Largest accepted LLM Context token budget. */
export const MAX_MAX_TOKENS = 32768;
/** Default LLM Context token budget. */
export const DEFAULT_MAX_TOKENS = 8192;

/** Smallest accepted per-attempt timeout. */
export const MIN_TIMEOUT_MS = 1;
/** Largest accepted per-attempt timeout: the ceiling `AbortSignal.timeout` allows. */
export const MAX_TIMEOUT_MS = 2147483647;
/** Default per-attempt timeout (Brave recommends 30 s). */
export const DEFAULT_TIMEOUT_MS = 30000;

/** Smallest accepted attempt count. */
export const MIN_MAX_ATTEMPTS = 1;
/** Largest accepted attempt count. */
export const MAX_MAX_ATTEMPTS = 10;
/** Default attempt count, including the first. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Default exponential-backoff base, in milliseconds. */
export const DEFAULT_RETRY_BASE_MS = 250;
/** Default minimum spacing between dispatched searches; 0 disables the throttle. */
export const DEFAULT_MIN_INTERVAL_MS = 0;

/** Attribution header sent on every request. Bump with the package version. */
export const USER_AGENT = 'dsh-web-search-brave/1.0.0';

/**
 * Plugin config: every field optional, with defaults applied by the schema or by
 * {@link resolveOptions}. There is intentionally no literal-key field, so no
 * secret can be written into a settings document or a profile entry.
 */
export const Config = z.object({
  apiKeyEnv: z
    .string()
    .role('credential-ref')
    .default(DEFAULT_API_KEY_ENV)
    .description('Credential reference holding the Brave Search API key. Resolved once per search; the value is never stored in configuration.'),
  secretManager: z
    .union([z.const(SECRET_MANAGER_AUTO), z.const(SECRET_MANAGER_NONE), z.const(SECRET_MANAGER_GNOME), z.const(SECRET_MANAGER_PASS)])
    .default(SECRET_MANAGER_AUTO)
    .description('Where to look for the key besides the harness credential store: auto tries the GNOME keyring and then pass; none disables password-manager lookups.'),
  gnomeKeyringAttributes: z
    .dict(z.string())
    .default({ ...DEFAULT_GNOME_KEYRING_ATTRIBUTES })
    .description('Attributes identifying the GNOME keyring item, exactly as secret-tool lookup receives them.'),
  passPath: z
    .string()
    .default(DEFAULT_PASS_PATH)
    .description('Entry path inside the pass password store to read the key from.'),
  baseURL: z
    .string()
    .description('Brave Search API base, /res/v1 included. Defaults to the BRAVE_SEARCH_BASE_URL environment variable when set, then https://api.search.brave.com/res/v1.'),
  mode: z
    .union([z.const(MODE_LLM_CONTEXT), z.const(MODE_WEB_SEARCH)])
    .default(DEFAULT_MODE)
    .description('llm-context asks for agent-oriented grounding chunks; web-search asks for the human-oriented results page.'),
  country: z.string().default(DEFAULT_COUNTRY).description('ISO 3166-1 alpha-2 country code for results.'),
  searchLang: z.string().default(DEFAULT_SEARCH_LANG).description('ISO 639-1 language code for results.'),
  safesearch: z
    .union([z.const('off'), z.const('moderate'), z.const('strict')])
    .description('Adult-content filter. Unset omits the parameter, leaving the default in force.'),
  freshness: z.string().description('Recency filter: pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD. Unset omits the parameter.'),
  count: z
    .number()
    .step(1)
    .min(MIN_COUNT)
    .max(MAX_COUNT)
    .default(DEFAULT_COUNT)
    .description('Requested result count, clamped to 50 in llm-context mode and 20 in web-search mode. A request-level maxResults wins over this.'),
  maxTokens: z
    .number()
    .step(1)
    .min(MIN_MAX_TOKENS)
    .max(MAX_MAX_TOKENS)
    .default(DEFAULT_MAX_TOKENS)
    .description('Maximum tokens of LLM Context returned. Used by llm-context mode only.'),
  contextThresholdMode: z
    .union([z.const('strict'), z.const('balanced'), z.const('lenient'), z.const('disabled')])
    .description('LLM Context inclusion threshold. Unset omits the parameter. Used by llm-context mode only.'),
  timeoutMs: z
    .number()
    .step(1)
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .default(DEFAULT_TIMEOUT_MS)
    .description('Per-attempt request timeout in milliseconds.'),
  maxAttempts: z
    .number()
    .step(1)
    .min(MIN_MAX_ATTEMPTS)
    .max(MAX_MAX_ATTEMPTS)
    .default(DEFAULT_MAX_ATTEMPTS)
    .description('Total attempts, including the first, for retryable failures (429, 408, 5xx, and transient transport errors).'),
  retryBaseMs: z
    .number()
    .min(0)
    .default(DEFAULT_RETRY_BASE_MS)
    .description('Base delay of the exponential backoff between attempts, in milliseconds.'),
  minIntervalMs: z
    .number()
    .min(0)
    .default(DEFAULT_MIN_INTERVAL_MS)
    .description('Minimum spacing between dispatched searches, in milliseconds; 0 disables client-side throttling.'),
});

/**
 * Largest result count one mode accepts.
 * @param mode - the resolved mode.
 * @returns 50 for `llm-context`, 20 for `web-search`.
 */
export function maxCountForMode(mode) {
  return mode === MODE_WEB_SEARCH ? MAX_COUNT_WEB_SEARCH : MAX_COUNT_LLM_CONTEXT;
}

/**
 * Number of results one search should ask Brave for: the request's
 * `maxResults` when it carries a usable positive integer, otherwise the
 * configured count, in both cases clamped to the mode's ceiling.
 * @param maxResults - the request's optional bound (the tool layer sends 8).
 * @param count - the configured count.
 * @param mode - the resolved mode.
 * @returns a count in the range 1..maxCountForMode(mode).
 */
export function effectiveCount(maxResults, count, mode) {
  const requested = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : count;
  return clampInteger(requested, MIN_COUNT, maxCountForMode(mode), DEFAULT_COUNT);
}

/**
 * Clamp a value into an integer range, falling back when it is not a usable
 * number. Defensive by design: an out-of-range settings value is corrected, not
 * thrown, so one bad field cannot disable the provider.
 * @param value - the candidate.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @param fallback - used when the candidate is not a finite number.
 * @returns the clamped integer.
 */
export function clampInteger(value, min, max, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const floored = Math.floor(number);
  if (!Number.isFinite(floored)) return fallback;
  return Math.min(max, Math.max(min, floored));
}

/**
 * Return a trimmed, non-empty string or `undefined`.
 * @param value - the candidate.
 * @returns the trimmed string, or `undefined` when it holds nothing usable.
 */
export function nonEmptyString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Return the candidate when it is one of `allowed`, else the fallback. Enum-ish
 * configuration values are corrected rather than thrown.
 * @param value - the candidate.
 * @param allowed - accepted values.
 * @param fallback - value used when the candidate is not accepted.
 * @returns the accepted value or the fallback.
 */
export function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/**
 * Brand the configured credential reference, falling back to the default when
 * the configured name is not a POSIX identifier `credentialRef` would accept.
 * @param value - the configured name.
 * @param fallback - reference used when the configured name is unusable.
 * @returns the branded reference.
 */
export function credentialReferenceOr(value, fallback) {
  return typeof value === 'string' && isCredentialRefName(value) ? credentialRef(value) : credentialRef(fallback);
}

/**
 * Project one authoritative config section into the options the provider serves
 * its next search with. Environment fallbacks and constants are applied here and
 * only here, so every value the provider reads is already fully defaulted.
 * The credential is resolved once per search, in a fixed order: the harness
 * credential store, then the configured secret managers, then — only when no
 * credential provider is mounted — the launch environment.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @param deps - optional seams; `execFile` replaces the secret-manager command runner.
 * @returns options for one search.
 */
export function resolveOptions(ctx, config, deps = {}) {
  const source = config ?? {};
  const environment = launchEnvironmentOf(ctx);
  const apiKeyEnv = credentialReferenceOr(source.apiKeyEnv, DEFAULT_API_KEY_ENV);
  const configuredAttributes = Object.fromEntries(secretAttributes(source.gnomeKeyringAttributes));
  const secretOptions = {
    manager: oneOf(source.secretManager, SECRET_MANAGERS, SECRET_MANAGER_AUTO),
    gnomeKeyringAttributes: Object.keys(configuredAttributes).length > 0 ? configuredAttributes : DEFAULT_GNOME_KEYRING_ATTRIBUTES,
    passPath: nonEmptyString(source.passPath) ?? DEFAULT_PASS_PATH,
    execFile: deps.execFile,
  };
  return {
    resolveApiKey: async (signal) => {
      const attempted = [];
      const credentials = ctx.get('credentials');
      if (credentials !== undefined) {
        const stored = await credentials.resolve(apiKeyEnv);
        if (stored !== undefined && typeof stored.value === 'string' && stored.value.length > 0) {
          return { value: stored.value, source: 'credentials:' + stored.source, attempted };
        }
        attempted.push('the harness credential store: "' + safeCredentialLabel(apiKeyEnv) + '" is not configured');
      }
      const secret = await resolveSecret({ ...secretOptions, signal });
      attempted.push(...secret.attempted);
      if (secret.value !== undefined) return { value: secret.value, source: secret.source, attempted };
      if (credentials === undefined) {
        const ambient = environment.get(apiKeyEnv);
        if (ambient !== undefined && ambient.value.length > 0) {
          return { value: ambient.value, source: 'launch environment', attempted };
        }
        attempted.push('the launch environment: ' + safeCredentialLabel(apiKeyEnv) + ' is not set');
      }
      return { value: undefined, source: undefined, attempted };
    },
    apiKeyEnv,
    secretManager: secretOptions.manager,
    gnomeKeyringAttributes: secretOptions.gnomeKeyringAttributes,
    passPath: secretOptions.passPath,
    baseURL: nonEmptyString(source.baseURL) ?? nonEmptyString(environment.get(BASE_URL_ENV)?.value) ?? DEFAULT_BASE_URL,
    mode: oneOf(source.mode, MODES, DEFAULT_MODE),
    country: nonEmptyString(source.country) ?? DEFAULT_COUNTRY,
    searchLang: nonEmptyString(source.searchLang) ?? DEFAULT_SEARCH_LANG,
    safesearch: oneOf(source.safesearch, SAFESEARCH_VALUES, undefined),
    freshness: nonEmptyString(source.freshness),
    count: clampInteger(source.count, MIN_COUNT, MAX_COUNT, DEFAULT_COUNT),
    maxTokens: clampInteger(source.maxTokens, MIN_MAX_TOKENS, MAX_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    contextThresholdMode: oneOf(source.contextThresholdMode, CONTEXT_THRESHOLD_MODES, undefined),
    timeoutMs: clampInteger(source.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxAttempts: clampInteger(source.maxAttempts, MIN_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    retryBaseMs: clampInteger(source.retryBaseMs, 0, Number.MAX_SAFE_INTEGER, DEFAULT_RETRY_BASE_MS),
    minIntervalMs: clampInteger(source.minIntervalMs, 0, Number.MAX_SAFE_INTEGER, DEFAULT_MIN_INTERVAL_MS),
    recordRequest: (event) => {
      ctx.get('agents')?.currentInitiator()?.session.append(SEARCH_REQUEST_EVENT, event);
    },
  };
}
