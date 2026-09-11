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
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
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
export const MODES = Object.freeze([MODE_LLM_CONTEXT, MODE_WEB_SEARCH]);

/** Path of the LLM Context endpoint, appended to the base URL. */
export const LLM_CONTEXT_PATH = '/llm/context';
/** Path of the Web Search endpoint, appended to the base URL. */
export const WEB_SEARCH_PATH = '/web/search';

/** Accepted `safesearch` values. */
export const SAFESEARCH_VALUES = Object.freeze(['off', 'moderate', 'strict']);
/** Accepted `contextThresholdMode` values. */
export const CONTEXT_THRESHOLD_MODES = Object.freeze(['strict', 'balanced', 'lenient', 'disabled']);

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
/**
 * Largest accepted per-attempt timeout. This is the ceiling a `setTimeout` delay
 * can carry: a larger value overflows the 32-bit field and Node clamps it to
 * 1 ms with a `TimeoutOverflowWarning`, which would turn "wait longer" into
 * "give up immediately". The transport arms the deadline with a plain
 * `setTimeout` (see `attemptTimeout`), so this bound is what that call accepts.
 */
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
/**
 * Largest accepted backoff base. The client already shortens every computed
 * delay to its own 30 s ceiling, so a larger base cannot produce a longer wait —
 * it would only round-trip a value that misleads whoever reads the settings
 * document.
 */
export const MAX_RETRY_BASE_MS = 30000;
/** Default minimum spacing between dispatched searches; 0 disables the throttle. */
export const DEFAULT_MIN_INTERVAL_MS = 0;
/**
 * Largest accepted spacing between dispatched searches: one minute, matching the
 * longest server `Retry-After` the client will honour. The value reaches a
 * `setTimeout`, so an unbounded one overflows to a 1 ms delay (with a warning)
 * and silently turns the throttle off instead of spacing searches out.
 */
export const MAX_MIN_INTERVAL_MS = 60000;

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
  country: z
    .string()
    .pattern(/^[a-z]{2}$/iu)
    .default(DEFAULT_COUNTRY)
    .description('ISO 3166-1 alpha-2 country code for results, e.g. us or gb.'),
  searchLang: z
    .string()
    .pattern(/^[a-z]{2,3}(?:-[a-z]{2})?$/iu)
    .default(DEFAULT_SEARCH_LANG)
    .description('ISO 639-1 language code for results, with an optional region, e.g. en or pt-br.'),
  safesearch: z
    .union([z.const('off'), z.const('moderate'), z.const('strict')])
    .description('Adult-content filter. Unset omits the parameter, leaving the default in force.'),
  // Constrained to the documented shapes rather than any non-blank string: Brave
  // rejects an unrecognized value with a 422, so a typo here would turn every
  // search into an error instead of being corrected the way the other enum-ish
  // fields are.
  freshness: z
    .string()
    // `u` alone is not enough: `\d` and the alternation must not be case-folded,
    // and the pattern is anchored so a trailing space cannot slip through.
    .pattern(/^(?:pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/u)
    .description('Recency filter: pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD. Unset omits the parameter.'),
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
    .max(MAX_RETRY_BASE_MS)
    .default(DEFAULT_RETRY_BASE_MS)
    .description('Base delay of the exponential backoff between attempts, in milliseconds.'),
  minIntervalMs: z
    .number()
    .min(0)
    .max(MAX_MIN_INTERVAL_MS)
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
 * Decide which credential reference to use, and whether the configured one had
 * to be rejected.
 *
 * A configured name that is not a POSIX identifier `credentialRef` accepts is
 * replaced by the default, because the credential plane would reject it. That
 * substitution is silent by nature — the default is a working reference — so the
 * rejection is reported back to the caller, which explains it in the
 * missing-credential message. Without that note the operator is told to set a
 * variable they never mentioned, and a real key pasted into the field (Brave
 * keys contain `-` and `_`, so they are often not valid identifiers) disappears
 * without a trace.
 * @param value - the configured name.
 * @param fallback - reference used when the configured name is unusable.
 * @returns the branded reference and the rejected candidate, when there was one.
 */
export function credentialReferenceOr(value, fallback) {
  if (typeof value === 'string' && isCredentialRefName(value)) return { reference: credentialRef(value), rejected: undefined };
  const candidate = typeof value === 'string' ? value.trim() : '';
  return { reference: credentialRef(fallback), rejected: candidate.length > 0 ? candidate : undefined };
}

/** Schemes a base URL may use. The token travels in a header, so plaintext HTTP is a real exposure. */
const BASE_URL_PROTOCOLS = ['https:', 'http:'];

/**
 * Normalize a configured API base, accepting only what the transport can safely
 * append a path to and send a credential to.
 *
 * `URL.canParse` alone accepts `javascript:`, `file:`, and `data:`, none of which
 * is a search endpoint, and it accepts credentials, a query string, and a
 * fragment, each of which breaks the appended endpoint path or copies a secret
 * into the recorded request event. A value that fails any of those checks, or is
 * not a string at all, is rejected.
 *
 * Trailing slashes are stripped so the recorded endpoint is the one actually
 * requested; `joinUrl` would tolerate them, but only one of the two forms should
 * ever reach a diagnostic.
 * @param value - a candidate base URL.
 * @returns the normalized base URL, or `undefined` when the candidate is unusable.
 */
export function normalizedBaseUrl(value) {
  const raw = nonEmptyString(value);
  if (raw === undefined) return undefined;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (!BASE_URL_PROTOCOLS.includes(parsed.protocol)) return undefined;
  if (parsed.username.length > 0 || parsed.password.length > 0) return undefined;
  if (parsed.search.length > 0 || parsed.hash.length > 0) return undefined;
  return parsed.origin + parsed.pathname.replace(/\/+$/u, '');
}

/**
 * Resolve the API base from the settings section and the launch environment.
 *
 * The two failure modes are deliberately different, because they mean different
 * things. *Unset* — no section value, no environment value, or a blank one — is
 * the normal case and takes the Brave default. *Set but unusable* is a
 * misconfiguration, and it is returned verbatim rather than replaced: silently
 * substituting the default would send the subscription token to a host the
 * operator did not choose, which is the one outcome this validation exists to
 * prevent. An unusable value therefore makes the provider report itself
 * unavailable (see `optionsAreUsable`) instead of quietly searching somewhere
 * else. `SECURITY.md` documents the boundary.
 * @param configured - the settings section's `baseURL`, when present.
 * @param environmentValue - the launch-environment fallback, consulted second.
 * @returns the base URL the transport should use.
 */
function resolveBaseUrl(configured, environmentValue) {
  const fromSettings = normalizedBaseUrl(configured);
  if (fromSettings !== undefined) return fromSettings;
  if (nonEmptyString(configured) !== undefined) return String(configured);
  const fromEnvironment = normalizedBaseUrl(environmentValue);
  if (fromEnvironment !== undefined) return fromEnvironment;
  if (nonEmptyString(environmentValue) !== undefined) return String(environmentValue);
  return DEFAULT_BASE_URL;
}

/**
 * The launch environment for one plugin context, falling back to the inherited
 * `process.env` when the launcher supplied no snapshot.
 *
 * The fallback snapshot is memoized per context because building it copies every
 * variable of `process.env` into a fresh `Map` — measured at ~81 µs for 93
 * variables, against ~0.3 µs once cached. {@link resolveOptions} runs on every
 * provider-selection probe and twice per search, so without the cache this cost
 * is paid repeatedly inside a long-lived harness process for the same immutable
 * data. The snapshot is never mutated after construction, so sharing it is safe.
 */
const FALLBACK_ENVIRONMENTS = new WeakMap();

function environmentFor(ctx) {
  const supplied = ctx.get('launchEnvironment');
  if (supplied !== undefined) return supplied;
  let fallback = FALLBACK_ENVIRONMENTS.get(ctx);
  if (fallback === undefined) {
    fallback = createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]);
    FALLBACK_ENVIRONMENTS.set(ctx, fallback);
  }
  return fallback;
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
  const environment = environmentFor(ctx);
  const credentialReference = credentialReferenceOr(source.apiKeyEnv, DEFAULT_API_KEY_ENV);
  const apiKeyEnv = credentialReference.reference;
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
      if (credentialReference.rejected !== undefined) {
        attempted.push(
          'the configured apiKeyEnv: ' +
            safeCredentialLabel(credentialReference.rejected) +
            ' is not a usable credential name, so the default reference was used instead',
        );
      }
      const credentials = ctx.get('credentials');
      if (credentials !== undefined) {
        const stored = await credentials.resolve(apiKeyEnv);
        if (stored !== undefined && typeof stored.value === 'string' && stored.value.trim().length > 0) {
          return { value: stored.value, source: 'credentials:' + stored.source, attempted };
        }
        attempted.push('the harness credential store: "' + safeCredentialLabel(apiKeyEnv) + '" is not configured');
      }
      const secret = await resolveSecret({ ...secretOptions, signal });
      attempted.push(...secret.attempted);
      if (secret.value !== undefined) return { value: secret.value, source: secret.source, attempted };
      if (credentials === undefined) {
        const ambient = environment.get(apiKeyEnv);
        // A whitespace-only environment value is absent, matching the secret
        // managers, which trim. Without the trim a variable set to spaces would
        // count as a present credential and be sent as the request header.
        if (ambient !== undefined && ambient.value.trim().length > 0) {
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
    baseURL: resolveBaseUrl(source.baseURL, environment.get(BASE_URL_ENV)?.value),
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
    retryBaseMs: clampInteger(source.retryBaseMs, 0, MAX_RETRY_BASE_MS, DEFAULT_RETRY_BASE_MS),
    minIntervalMs: clampInteger(source.minIntervalMs, 0, MAX_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS),
    recordRequest: (event) => {
      // Recording is an observability side channel, never a gate on the search:
      // the session's `append` validates its payload and throws for a value that
      // does not survive a JSON round trip, and a request that reached this point
      // has already been validated. A refused append must therefore not turn a
      // working search into a failure, so it is swallowed here rather than
      // propagated. `search()` validates the query itself, before this is called.
      try {
        ctx.get('agents')?.currentInitiator()?.session.append(SEARCH_REQUEST_EVENT, event);
      } catch {
        // Deliberately ignored: see above.
      }
    },
  };
}
