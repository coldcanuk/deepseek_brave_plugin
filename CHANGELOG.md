# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`npm test` could not run on Node 20.** The script passed a quoted glob
  (`"test/**/*.test.js"`) to `node --test`, but positional globs were only added to the test runner
  in Node 21 while `engines` allows `>=20`. On Node 20 the pattern was never expanded, so Node looked
  for a file with that literal name and the command failed with `Could not find '…/test/**/*.test.js'`
  and exit code 1 — the suite could not run at all on a supported runtime. The script now uses
  no-argument discovery, which resolves the same files on every supported version.
- **A pending search could be killed by event-loop exhaustion instead of timing out.**
  `AbortSignal.timeout()` arms an *unreferenced* timer, so an attempt whose transport held no handle
  of its own — a promise-only `fetch` stand-in, or a socket that had not opened yet — left the event
  loop with nothing to keep Node alive. The process exited with an unsettled promise (exit code 13)
  rather than reporting the timeout, and inside the suite it surfaced as `cancelledByParent` on every
  later test in the file. Each attempt now uses a referenced timer, held for the request *and* its
  body read and released as soon as the attempt settles, so a pending search keeps the process alive
  while a completed one never delays exit. Verified on Node 20 and Node 24.
- **The test gate could pass while executing nothing.** This one is latent rather than active: on
  Node 21 and newer the runner reports a glob matching no files as a *vacuous success* — `tests 0`,
  exit code 0 — so any future regression in how the suite is selected would have looked like a green
  build. `npm test` now runs `scripts/check-test-gate.mjs`, which fails unless at least 100 tests
  actually executed. `npm run test:raw` gives the bare runner output.
- **The credential scan had two patterns that could never match.** `check-secrets.mjs` matched the
  two assignment forms with a literal `s` where a `\s` whitespace class was intended — a lost escape,
  so `x-subscription-token = "…"` and `apiKey = "…"` were **not** findings while the scan still
  reported a clean run. Both patterns are corrected, the matcher is narrowed so a quoted literal is
  required (a reference such as `headers[SUBSCRIPTION_TOKEN_HEADER] = apiKey` is still not a
  finding), and `test/check-secrets.test.js` now pins every pattern against lines that must be caught
  and look-alikes that must not.
- **A JSDoc block was attached to the wrong declaration.** In `lib/errors.js` the documentation for
  `credentialMissingError` sat above the token-shape regex, leaving the exported function
  undocumented and the constant documented as something it is not. The comment is back on the
  function; the regex is now module-private, since nothing outside the module used it.
- **The declarations had drifted from the runtime exports.** `lib/types/errors.d.ts` omitted
  `safeCredentialLabel`, `lib/types/client.d.ts` omitted `SUBSCRIPTION_TOKEN_HEADER` (both exported
  and both consumed elsewhere in the package), and `credentialMissingError` was declared with one
  parameter while the implementation takes two. All three are corrected, and `npm run check:types`
  now fails on any recurrence.
- **An unusable `baseURL` was silently replaced by the Brave default.** The validation that rejects a
  non-HTTP scheme, an embedded credential, a query string, or a fragment is only half the fix: a
  rejected value used to fall through to `https://api.search.brave.com/res/v1`, which sends the
  subscription token to a host the operator did not choose — the exact outcome the check exists to
  prevent. A value that was *set* but is unusable is now kept as configured, so `available()` reports
  the provider unavailable and the search fails loudly. Absent or blank still takes the default,
  because absence is not a misconfiguration.
- **An invalid credential reference was swapped without a word.** A configured `apiKeyEnv` that is
  not a valid reference name was replaced by `BRAVE_SEARCH_API_KEY` and the user was then told to set
  that variable — one they never mentioned. Brave keys contain `-` and `_`, so a key pasted into the
  field is usually invalid as a reference, which is precisely the case where the explanation matters.
  The rejection is now reported as the first entry of the missing-credential message's "where the key
  was looked for" list.
- **The missing-credential message contradicted itself about storage.** It claimed a key typed into
  `apiKeyEnv` "is not stored anywhere", while the hint beside it correctly said the settings service
  persists the field. The settings service stores the section as written and only redacts fields
  marked `role('secret')`, which a readable reference cannot be. The false clause is gone; the honest
  one — that a key entered there should be treated as exposed and rotated — remains. `SECURITY.md`
  carried the same claim and is corrected.
- **`abortable` could leak an unhandled rejection.** Its already-aborted path returned a rejected
  promise without attaching any handler to the operation it was given, so an in-flight preflight that
  settled afterwards was fully unobserved; a later rejection surfaced as an unhandled rejection
  against whatever happened to be running. The observation is now attached before the rejection is
  returned. Found by the new `test/errors.test.js`, which is also the module's first direct cover.
- **A refused redirect was detected by substring.** `isRedirectError` matched the word "redirect"
  anywhere in a failure message, so a DNS or transport failure for a host named
  `redirect.example.test` was classified as a permanent redirect refusal and never retried. It now
  matches undici's actual wording (`unexpected redirect`, `ERR_INVALID_REDIRECT`).
- **Two failure messages could end in a dangling colon.** An unreadable or blank error body rendered
  as `Brave search API error (HTTP 500): ` with nothing after it, and an empty 200 body as
  `... was not JSON (HTTP 200): `. The detail clause is now omitted when there is no detail, and an
  empty body is named as such.
- **The credential scan followed the caller's working directory.** `check-secrets.mjs` ran
  `git ls-files` without `-C`, so from another repository it reported a confident "clean" about the
  wrong tree, and outside one it died inside `execFileSync` instead of explaining itself. It now
  derives the repository root from its own location, reads files relative to that root, and exits
  with a diagnostic when `git` cannot answer.
- **A cancellation signal of the wrong type escaped as a raw `TypeError`.** `AbortSignal.any` rejects
  anything that is not an `AbortSignal`, and that call sat outside the transport's error handling, so
  the misuse surfaced as a non-seam error with the attempt deadline still armed.
- **`parseRetryAfter` was documented as returning `undefined` for a past date.** It returns `0` —
  retry immediately — which is the behavior a server means by sending a date that has already passed.

### Changed

- **`minIntervalMs` and `retryBaseMs` are bounded.** Both reached `setTimeout` unbounded, and a delay
  above `2**31-1` overflows the timer's 32-bit field: Node clamps it to 1 ms and warns. For
  `minIntervalMs` that turned "space searches out" into "do not space them at all" — silently, with a
  warning per dispatch. The schema and the resolved-option clamp now cap them at 60 s and 30 s, the
  same ceilings the client already applied to the delays it computes.
- **`country`, `searchLang`, and `freshness` are validated in the schema** rather than accepted as any
  non-blank string. Each is forwarded to Brave as a query parameter, and Brave answers an
  unrecognized value with a 422, so a typo used to turn every search into an error.
- **`baseURL` is documented as a trust boundary.** `SECURITY.md` gained a section on what a
  configurable API base means (it decides which host receives the subscription-token header), which
  mitigations are in place (redirects refused, the key never in a URL, the value never taken from a
  search request, non-HTTP shapes rejected), what is deliberately not enforced (no compiled-in host
  allowlist, so a local mock and a corporate proxy keep working), and how an operator checks what a
  running harness resolved. The README's options table links to it.
- **`resolveOptions` no longer re-materializes the launch environment on every call.** When the
  plugin context carries no `launchEnvironment` slot, the fallback snapshot copies every variable of
  `process.env` into a fresh `Map`; measured at ~81 µs per call for 93 variables, against ~0.2 µs
  once cached. `resolveOptions` runs on every provider-selection probe and twice per search, so the
  cost was paid repeatedly for the same immutable data. The fallback is now memoized per context with
  a `WeakMap` — roughly 420× cheaper on that path — while a snapshot supplied by the launcher still
  takes precedence and is never masked by the cache.

### Added

- **`attemptTimeout(timeoutMs)`** in `lib/client.js`, exported from the package entry: one attempt's
  referenced deadline, with `didTimeOut()` and an idempotent `dispose()`.
- **`test/keepalive.test.js`** — spawns child processes to pin the transport guarantee that the
  runner's own event loop would otherwise mask: a pending attempt stays alive until its deadline
  fires, a completed search releases its timer, and a failed attempt does not hold the process for
  the rest of its deadline.
- **`test/attempt-timeout.test.js`** — unit cover for the deadline's own contract.
- **`scripts/check-test-gate.mjs`** — the vacuous-test-run guard, wired into `npm test`.
- **`scripts/check-types.mjs`** — compares each `lib/*.js` runtime export surface against its
  hand-authored `lib/types/*.d.ts` in both directions, wired in as `npm run check:types`. It found
  three real pieces of drift the moment it first ran (see *Fixed*).
- **`test/check-secrets.test.js`** — pins the credential scan's patterns against lines that must be
  caught and look-alikes that must not, including the end-to-end contract that a clean repository
  exits zero and that no matched text is ever printed.
- **`test/errors.test.js`** — the first direct cover for `lib/errors.js`: redaction including the
  documented minimum length, abort classification, `abortable`'s settlement guarantees, and the two
  messages that must never echo a pasted key.
- **A CI workflow** at `.github/workflows/ci.yml`: on every push to `main`, every pull request, and
  on demand, it installs with `npm ci` and runs the suite, the credential scan, the lint, both
  declaration checks, and the coverage floors on Node 20, 22, and 24. Dependabot keeps dependencies
  current, but nothing about a Dependabot pull request proved the suite still passed; this is that
  gate.
- **A lint gate**, `npm run check:lint`: Biome with its recommended rules, formatter and assist
  disabled so it can never reformat the tree, and `--error-on-warnings` so a finding fails the build.
  Its first run found six real defects — four unused imports, an unused variable, and two unused
  callback parameters — which are fixed.
- **A coverage gate**, `npm run check:coverage`: lines 95%, branches 88%, functions 92%, measured
  over `lib/`. The floors sit a few points under the current baseline (≈99.1% / ≈94.7% / ≈96.8%) so
  they catch a new untested path without failing on churn. `npm run test:coverage` reports without
  enforcing.
- **`npm run check`** — every gate above, in order, in one command.
- **`tsconfig.json`** and `devDependencies` (`typescript`, `@types/node`, `@biomejs/biome`), backing
  `npm run check:types:tsc` and `npm run check:lint`. The config is `noEmit`, so the declarations can
  be type-checked without a build step or any generated output.

## [1.0.0] - 2026-09-11

### Added

- **Password-manager credential sources.** The key can live in the GNOME keyring
  (`secret-tool lookup service dsh-web-search-brave`) or in `pass` (`pass show
  dsh/brave-search-api`) instead of a cleartext file, selected by the new `secretManager`,
  `gnomeKeyringAttributes`, and `passPath` options. Resolution is a fixed chain — harness
  credential store, then the configured password manager, then the launch environment only when no
  credential provider is mounted — and `WEB_PROVIDER_CREDENTIAL_MISSING` now lists every source
  tried. Lookups are best-effort (a missing, locked, empty, or slow tool falls through), use a
  closed set of executables through `execFile` with no shell, never carry the secret in argv, and
  never log tool output.
- **Profile bundle declaration** (`dsh.bundle.patch` plus a shipped `cordis.patch.yml`), so
  `dsh plugin --profile <name> add` installs the plugin *and* composes it — registering the
  provider and pinning the `web` seam at `brave-official` — with no patch-file editing, and
  `remove` reverses it. The API key is set from the harness settings page (a credential
  reference) or the launch environment.
- **Scoped npm package name** `@coldcanuk/dsh-web-search-brave`. The bare name
  `dsh-web-search-brave` is taken on npm by an unrelated third-party package whose harness peers
  are pinned to `^0.0.1-rc.*`, so installing the bare name fetched that package instead of this
  one. Install from this repository by git URL or path. The cordis plugin name stays
  `web-search-brave` and the provider id stays `brave-official`.
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
