// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Register a Brave-backed search provider in `ctx.web`.
 * @module dsh-web-search-brave
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';

/** Cordis plugin name used by loader diagnostics. */
export declare const name = "web-search-brave";
/** The web seam this provider registers into. */
export declare const inject: string[];
/** Register the Brave search provider with `ctx.web` and install the settings section when settings are present. */
export declare function apply(ctx: Context, config: Config): void;

export { Config, PROVIDER_ID, SETTINGS_NAMESPACE, resolveOptions } from './config.js';
export { BASE_URL_ENV, CONTEXT_THRESHOLD_MODES, DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_COUNTRY, DEFAULT_COUNT, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_TOKENS, DEFAULT_MIN_INTERVAL_MS, DEFAULT_MODE, DEFAULT_RETRY_BASE_MS, DEFAULT_SEARCH_LANG, DEFAULT_TIMEOUT_MS, LLM_CONTEXT_PATH, MAX_COUNT_LLM_CONTEXT, MAX_COUNT_WEB_SEARCH, MAX_MAX_TOKENS, MIN_MAX_TOKENS, MODES, MODE_LLM_CONTEXT, MODE_WEB_SEARCH, SAFESEARCH_VALUES, SEARCH_REQUEST_EVENT, WEB_SEARCH_PATH, effectiveCount, maxCountForMode, } from './config.js';
export type { BraveContextThresholdMode, BraveSafeSearch, BraveSearchMode, BraveSearchProviderOptions, BraveSearchRequestEvent } from './config.js';
export { BraveSearchProvider, optionsAreUsable } from './provider.js';
export { WEB_ABORTED, WEB_PROVIDER_CREDENTIAL_MISSING, WEB_PROVIDER_ERROR } from './errors.js';
