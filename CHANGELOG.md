# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-11

### Added

- **Brave Search provider for `ctx.web`** registered as `brave-official` (`web-search-brave`
  settings namespace), so the model-facing `web_search` tool is answered by the Brave Search API.
- **Two modes.** `llm-context` (default) queries `GET /res/v1/llm/context` for agent-oriented
  grounding chunks and their publication ages; `web-search` queries `GET /res/v1/web/search` for
  the human-oriented results page with clean, undecorated descriptions.
- **Pure response mappers** for both envelopes: URL-keyed deduplication, blank-line snippet
  joining, ISO-8601-then-calendar-date publication precedence, empty results as a legitimate empty
  answer, and a `WEB_PROVIDER_ERROR` for a wrong-shaped body.
- **Credential resolution per search** through `ctx.credentials` with a launch-environment
  fallback; no literal-key configuration field, no caching, and no key in the URL, a session event,
  or an error message.
- **Transport hardening.** `redirect: 'error'`, a per-attempt `AbortSignal.timeout` (`timeoutMs`,
  default 30 s), caller cancellation distinguished from our own timeout (`WEB_ABORTED` versus
  `WEB_PROVIDER_ERROR`), retries with exponential backoff for `429`/`408`/`5xx` and transient
  transport failures, `Retry-After` support, an abortable backoff sleep, and an optional
  `minIntervalMs` throttle that serializes dispatch through a promise chain.
- **Settings integration** via `installSection`, so a live settings change applies to the next
  search without re-registering the provider.
- **Secret-free session event** `web/brave-search-request` recording the endpoint, mode, query, and
  non-secret parameters before dispatch.
- **Hand-authored `.d.ts` declarations** for every `lib/` module.
- **Hermetic test suite** on `node:test` — 92 tests over configuration, mapping, transport,
  provider behavior, and the plugin entry — driven by a local mock Brave server and injected
  `fetch`/`sleep` seams. No API key and no network access are required.
- Documentation: `README.md` (modes, options, mappings, errors, harness-profile setup) and
  `SECURITY.md` (credential model, reporting, rotation).

[1.0.0]: https://github.com/coldcanuk/deepseek_brave_plugin/releases/tag/v1.0.0
