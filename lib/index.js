// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Register a Brave-backed search provider in `ctx.web`, so the model-facing
 * `web_search` tool is answered by the Brave Search API instead of the
 * harness's native search.
 *
 * The plugin owns no key material. `apiKeyEnv` names a credential reference
 * that is resolved once per search through `ctx.credentials`, falling back to
 * the launch environment; the value travels only in the
 * `X-Subscription-Token` header.
 *
 * @module dsh-web-search-brave
 */
import { Config, PROVIDER_ID, SETTINGS_NAMESPACE, resolveOptions } from './config.js';
import { BraveSearchProvider } from './provider.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-brave';
/** The web seam this provider registers into. */
export const inject = ['web'];

/**
 * Register the Brave search provider with `ctx.web` and, when the settings
 * service is present, install this plugin's settings section.
 *
 * The provider reads its options through a thunk, so a settings change applies
 * to the next search without re-registering the provider.
 * @param ctx - the plugin context; `web` is injected and `settings` is optional.
 * @param config - the composition entry, used until a settings section resolves.
 */
export function apply(ctx, config) {
  let current = () => config;
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source;
      },
      onChange: () => {},
    });
  });
  ctx.web.registerSearchProvider(new BraveSearchProvider((deps) => resolveOptions(ctx, current(), deps)));
}

export { Config, PROVIDER_ID, SETTINGS_NAMESPACE, resolveOptions } from './config.js';
export {
  BASE_URL_ENV,
  CONTEXT_THRESHOLD_MODES,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_COUNTRY,
  DEFAULT_COUNT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_MODE,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_SEARCH_LANG,
  DEFAULT_TIMEOUT_MS,
  LLM_CONTEXT_PATH,
  MAX_COUNT_LLM_CONTEXT,
  MAX_COUNT_WEB_SEARCH,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  MODES,
  MODE_LLM_CONTEXT,
  MODE_WEB_SEARCH,
  SAFESEARCH_VALUES,
  SEARCH_REQUEST_EVENT,
  WEB_SEARCH_PATH,
  effectiveCount,
  maxCountForMode,
} from './config.js';
export { BraveSearchProvider, optionsAreUsable } from './provider.js';
export {
  DEFAULT_GNOME_KEYRING_ATTRIBUTES,
  DEFAULT_PASS_PATH,
  GNOME_SECRET_TOOL,
  PASS_TOOL,
  SECRET_LOOKUP_TIMEOUT_MS,
  SECRET_MANAGER_AUTO,
  SECRET_MANAGER_GNOME,
  SECRET_MANAGER_NONE,
  SECRET_MANAGER_PASS,
  SECRET_MANAGERS,
  firstLine,
  lookupGnomeKeyring,
  lookupPass,
  resolveSecret,
  secretAttributes,
} from './secrets.js';
export { WEB_ABORTED, WEB_PROVIDER_CREDENTIAL_MISSING, WEB_PROVIDER_ERROR } from './errors.js';
