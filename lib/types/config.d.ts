// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Configuration surface and option resolution for the Brave search provider.
 * @module dsh-web-search-brave/config
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { SecretExecFile, SecretManager } from './secrets.js';
import z from '@deepseek-ai/schemastery';

/** Settings namespace this plugin installs its section under. */
export declare const SETTINGS_NAMESPACE = "web-search-brave";
/** Stable provider id registered with `ctx.web`. */
export declare const PROVIDER_ID = "brave-official";
/** Session event recorded immediately before a Brave request is dispatched. */
export declare const SEARCH_REQUEST_EVENT = "web/brave-search-request";

/** Default credential reference: the launch environment variable naming the key. */
export declare const DEFAULT_API_KEY_ENV = "BRAVE_SEARCH_API_KEY";
/** Environment variable that overrides the API base. */
export declare const BASE_URL_ENV = "BRAVE_SEARCH_BASE_URL";
/** Brave Search API base, `/res/v1` included; endpoint paths are appended. */
export declare const DEFAULT_BASE_URL = "https://api.search.brave.com/res/v1";

/** Agent-oriented LLM Context endpoint. */
export declare const MODE_LLM_CONTEXT = "llm-context";
/** Human-oriented Web Search results endpoint. */
export declare const MODE_WEB_SEARCH = "web-search";
/** Every accepted `mode` value, in preference order. */
export declare const MODES: readonly BraveSearchMode[];
/** Default mode when none is configured. */
export declare const DEFAULT_MODE: BraveSearchMode;

/** Path of the LLM Context endpoint, appended to the base URL. */
export declare const LLM_CONTEXT_PATH = "/llm/context";
/** Path of the Web Search endpoint, appended to the base URL. */
export declare const WEB_SEARCH_PATH = "/web/search";

/** Accepted `safesearch` values. */
export declare const SAFESEARCH_VALUES: readonly BraveSafeSearch[];
/** Accepted `contextThresholdMode` values. */
export declare const CONTEXT_THRESHOLD_MODES: readonly BraveContextThresholdMode[];

/** Default ISO 3166-1 alpha-2 country code for search results. */
export declare const DEFAULT_COUNTRY = "us";
/** Default ISO 639-1 language code for search results. */
export declare const DEFAULT_SEARCH_LANG = "en";
/** Smallest accepted result count. */
export declare const MIN_COUNT = 1;
/** Largest result count `llm-context` accepts. */
export declare const MAX_COUNT_LLM_CONTEXT = 50;
/** Largest result count `web-search` accepts. Brave rejects anything above 20. */
export declare const MAX_COUNT_WEB_SEARCH = 20;
/** Largest result count the schema admits; per-mode clamping happens later. */
export declare const MAX_COUNT = 50;
/** Default result count. */
export declare const DEFAULT_COUNT = 20;
/** Smallest accepted LLM Context token budget. */
export declare const MIN_MAX_TOKENS = 1024;
/** Largest accepted LLM Context token budget. */
export declare const MAX_MAX_TOKENS = 32768;
/** Default LLM Context token budget. */
export declare const DEFAULT_MAX_TOKENS = 8192;
/** Smallest accepted per-attempt timeout. */
export declare const MIN_TIMEOUT_MS = 1;
/** Largest accepted per-attempt timeout. */
export declare const MAX_TIMEOUT_MS = 2147483647;
/** Default per-attempt timeout (Brave recommends 30 s). */
export declare const DEFAULT_TIMEOUT_MS = 30000;
/** Smallest accepted attempt count. */
export declare const MIN_MAX_ATTEMPTS = 1;
/** Largest accepted attempt count. */
export declare const MAX_MAX_ATTEMPTS = 10;
/** Default attempt count, including the first. */
export declare const DEFAULT_MAX_ATTEMPTS = 3;
/** Default exponential-backoff base, in milliseconds. */
export declare const DEFAULT_RETRY_BASE_MS = 250;
/** Largest accepted backoff base; the client shortens every delay to its own 30 s ceiling. */
export declare const MAX_RETRY_BASE_MS = 30000;
/** Default minimum spacing between dispatched searches; 0 disables the throttle. */
export declare const DEFAULT_MIN_INTERVAL_MS = 0;
/** Largest accepted spacing between dispatched searches, matching the longest honored `Retry-After`. */
export declare const MAX_MIN_INTERVAL_MS = 60000;
/** Attribution header sent on every request. */
export declare const USER_AGENT = "dsh-web-search-brave/1.0.0";

/** Which Brave endpoint answers a search. */
export type BraveSearchMode = 'llm-context' | 'web-search';
/** Brave's adult-content filter setting. */
export type BraveSafeSearch = 'off' | 'moderate' | 'strict';
/** Brave's LLM Context inclusion threshold. */
export type BraveContextThresholdMode = 'strict' | 'balanced' | 'lenient' | 'disabled';

/** Plugin config: every field optional, with defaults applied by the schema or by {@link resolveOptions}. */
export interface Config {
    /** Credential reference holding the Brave Search API key. Defaults to `BRAVE_SEARCH_API_KEY`. */
    apiKeyEnv?: string;
    /** Password manager to consult besides the harness credential store. Defaults to `auto`. */
    secretManager?: SecretManager;
    /** Attributes identifying the GNOME keyring item. Defaults to `{ service: 'dsh-web-search-brave' }`. */
    gnomeKeyringAttributes?: Readonly<Record<string, string>>;
    /** Entry path inside the `pass` password store. Defaults to `dsh/brave-search-api`. */
    passPath?: string;
    /** Brave Search API base. Defaults to `BRAVE_SEARCH_BASE_URL`, then the public API base. */
    baseURL?: string;
    /** Which endpoint answers a search. Defaults to `llm-context`. */
    mode?: BraveSearchMode;
    /** ISO 3166-1 alpha-2 country code. Defaults to `us`. */
    country?: string;
    /** ISO 639-1 language code. Defaults to `en`. */
    searchLang?: string;
    /** Adult-content filter; unset omits the parameter. */
    safesearch?: BraveSafeSearch;
    /** Recency filter: `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`; unset omits the parameter. */
    freshness?: string;
    /** Requested result count, 1-50, clamped per mode. Defaults to 20. */
    count?: number;
    /** LLM Context token budget, 1024-32768. Defaults to 8192. */
    maxTokens?: number;
    /** LLM Context threshold; unset omits the parameter. */
    contextThresholdMode?: BraveContextThresholdMode;
    /** Per-attempt request timeout in milliseconds. Defaults to 30000. */
    timeoutMs?: number;
    /** Total attempts, 1-10, for retryable failures. Defaults to 3. */
    maxAttempts?: number;
    /** Exponential-backoff base in milliseconds. Defaults to 250. */
    retryBaseMs?: number;
    /** Minimum spacing between dispatched searches in milliseconds; 0 disables throttling. */
    minIntervalMs?: number;
}
/** The schemastery schema a settings UI renders and the composition entry is validated against. */
export declare const Config: z<Config>;

/** The exact, secret-free event recorded immediately before one Brave request is dispatched. */
export interface BraveSearchRequestEvent {
    /** Registered provider id. */
    readonly provider: string;
    /** Fully resolved endpoint URL, without its query string. */
    readonly endpoint: string;
    /** The endpoint family this request used. */
    readonly mode: BraveSearchMode;
    /** The query text. */
    readonly query: string;
    /** Every non-secret query parameter sent to Brave. */
    readonly params: Readonly<Record<string, string | number>>;
}

/** What one credential resolution found, and what it tried when it found nothing. */
export interface BraveCredentialResolution {
    /** The resolved value, when one was found. */
    readonly value?: string;
    /** Which source supplied it: `credentials:<layer>`, `gnome-keyring`, `pass`, or `launch environment`. */
    readonly source?: string;
    /** Secret-free notes for every source consulted before the outcome. */
    readonly attempted: readonly string[];
}

/** Resolved provider options: every value fully defaulted, with the credential left as a thunk. */
export interface BraveSearchProviderOptions {
    /** Resolve the current Brave API key for one search operation. */
    readonly resolveApiKey: (signal?: AbortSignal) => Promise<BraveCredentialResolution>;
    /** Credential reference named by missing-credential diagnostics. */
    readonly apiKeyEnv: CredentialRef;
    /** Password manager consulted besides the harness credential store. */
    readonly secretManager: SecretManager;
    /** Attributes identifying the GNOME keyring item. */
    readonly gnomeKeyringAttributes: Readonly<Record<string, string>>;
    /** Entry path inside the `pass` password store. */
    readonly passPath: string;
    /** Endpoint base; the mode's path is appended. */
    readonly baseURL: string;
    /** Which endpoint answers a search. */
    readonly mode: BraveSearchMode;
    /** ISO 3166-1 alpha-2 country code. */
    readonly country: string;
    /** ISO 639-1 language code. */
    readonly searchLang: string;
    /** Adult-content filter; absent omits the parameter. */
    readonly safesearch?: BraveSafeSearch;
    /** Recency filter; absent omits the parameter. */
    readonly freshness?: string;
    /** Configured result count, already clamped to the schema's 1-50 range. */
    readonly count: number;
    /** LLM Context token budget. */
    readonly maxTokens: number;
    /** LLM Context threshold; absent omits the parameter. */
    readonly contextThresholdMode?: BraveContextThresholdMode;
    /** Per-attempt request timeout in milliseconds. */
    readonly timeoutMs: number;
    /** Total attempts for retryable failures. */
    readonly maxAttempts: number;
    /** Exponential-backoff base in milliseconds. */
    readonly retryBaseMs: number;
    /** Minimum spacing between dispatched searches in milliseconds. */
    readonly minIntervalMs: number;
    /** Record the secret-free request event immediately before dispatch. */
    readonly recordRequest?: (event: BraveSearchRequestEvent) => void;
}

/** Largest result count one mode accepts. */
export declare function maxCountForMode(mode: BraveSearchMode): number;
/** The count one search asks for: the request's `maxResults` when usable, else the configured count, clamped per mode. */
export declare function effectiveCount(maxResults: number | undefined, count: number, mode: BraveSearchMode): number;
/** Clamp a value into an integer range, falling back when it is not a usable number. */
export declare function clampInteger(value: unknown, min: number, max: number, fallback: number): number;
/** Return a trimmed, non-empty string or `undefined`. */
export declare function nonEmptyString(value: unknown): string | undefined;
/** Return the candidate when it is one of `allowed`, else the fallback. */
export declare function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T;
export declare function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: undefined): T | undefined;
/**
 * Decide which credential reference to use. Reports a configured name that had to
 * be rejected, so the rejection can be explained in the missing-credential message.
 */
export declare function credentialReferenceOr(value: unknown, fallback: string): {
    reference: CredentialRef;
    rejected: string | undefined;
};
/**
 * Normalize a configured API base, accepting only an absolute http(s) URL with no
 * credentials, query string, or fragment. Returns `undefined` when neither
 * candidate is usable, so the caller decides between the default and refusing.
 */
export declare function normalizedBaseUrl(value: unknown, environmentValue: unknown): string | undefined;
/** Project one authoritative config section into the options the provider serves its next search with. */
export declare function resolveOptions(ctx: Context, config: Config | undefined, deps?: {
    execFile?: SecretExecFile;
}): BraveSearchProviderOptions;
