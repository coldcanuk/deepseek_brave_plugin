# dsh-web-search-brave

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that registers the
**Brave Search API** as a search provider in the harness web capability seam (`ctx.web`), so the
model-facing `web_search` tool is answered by Brave instead of by the harness's built-in search.

- **No build step.** `lib/` is hand-authored ESM plus hand-authored `.d.ts`. What is committed is
  what runs.
- **No runtime dependencies** beyond `@deepseek-ai/schemastery`; everything else is a peer.
- **No key material in this repository, ever.** Configuration carries a credential *reference*;
  the value is resolved once per search from the harness credential store, a password manager
  (GNOME keyring or `pass`), or the launch environment, and travels only in the
  `X-Subscription-Token` request header.

**Search terms:** brave search plugin for deepseek harness · dsh web_search provider · deepseek
harness brave search api · brave llm context api · cordis web search plugin · gnome keyring brave
api key

---

## Why two modes

Brave exposes the same subscription through two endpoints with different shapes, and the right
default depends on who is reading the answer.

| Mode | Endpoint | Shape | Use it when |
| --- | --- | --- | --- |
| `llm-context` (default) | `GET /res/v1/llm/context` | `grounding.generic[]` chunks with multi-paragraph `snippets[]`, plus a `sources` index carrying publication ages | An agent will read the result. Chunks are pre-extracted for grounding, so the model gets dense text rather than page furniture. |
| `web-search` | `GET /res/v1/web/search` | `web.results[]` with `title`, `description`, `page_age` | A human-facing "results page" shape is wanted, or you need Brave's classic ranking with short descriptions. |

Both modes return the same normalized seam shape, so switching modes changes the retrieval, not
the tool contract.

## Requirements

- A DeepSeek Harness with its `dsh` CLI; the examples use the built-in `web` profile. The harness
  supplies the peer packages this plugin declares (`@deepseek-ai/dsh-web`,
  `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-launch-environment`, `@deepseek-ai/dsh-settings`,
  `@deepseek-ai/cordis`).
- Node.js **20.3 or newer** for the process that runs the harness (`engines` declares `>=20`; the
  20.3 floor is `AbortSignal.any`, used to combine the caller's cancellation with the per-attempt
  timeout).
- A **Brave Search API key** on the "Search" plan. Both modes use it, and the free tier is enough to
  try it.
- Optional, recommended: the GNOME keyring (`secret-tool`) or `pass`, so the key never sits in a
  cleartext file.

## Install

Four steps, and nothing else is required.

**1. Add the plugin to your harness profile.**

```sh
dsh plugin --profile web add github:coldcanuk/deepseek_brave_plugin
```

That forwards `add` to the profile's package manager and appends the package to
`dsh.profile.bundles`, because the package declares `dsh.bundle.patch`. Its own
`cordis.patch.yml` then registers the provider and points the `web` seam at `brave-official` — so
there is **no patch file to edit and no configuration to write**; every option has a default. (What
that layer contains: [How the install composes](#how-the-install-composes).)

Hand-editing the profile's `package.json` is not enough on its own: it is this command that
reconciles `dsh.profile.bundles`, so a plain install would fetch the package without composing it.

Not on your `PATH`? See [If `dsh` is not on your PATH](#if-dsh-is-not-on-your-path).

**2. Restart the harness.** Module code loads at boot, and the shipped base layer disables HMR.
Sessions persist, so an open conversation survives the restart.

**3. Give it a key.** The first option is recommended: the key stays encrypted at rest and never
touches a file.

```sh
secret-tool store --label='Brave Search API (dsh-web-search-brave)' service dsh-web-search-brave
```

It prompts for the value. `pass insert dsh/brave-search-api` works just as well, and so do the
settings page (Settings → Plugins → Plugin configuration → Web search) and, as a cleartext last
resort, an exported `BRAVE_SEARCH_API_KEY` or a line in `~/.dsh/.env`. Precedence and details:
[Credentials](#credentials).

Because the key is resolved once per search, a key stored after step 2 takes effect on the next
search — no further restart.

**4. Verify.** Run any `web_search`. Success returns Brave sources. To check the composition
without booting anything:

```sh
dsh --profile web --dump-config > /dev/null && echo "composition ok"
```

If the key is not reaching the plugin, the search fails with
`WEB_PROVIDER_CREDENTIAL_MISSING`, whose message lists every source that was tried.

### If `dsh` is not on your PATH

Expected when the harness was started with `npx @deepseek-ai/dsh …`: npx installs the CLI into its
own cache and prepends that cache's `.bin` to the process it launches, so nothing lands in your
shell PATH or in the global npm bin. Run the same command through npx, pinned to the version you are
running, or call the cached binary directly:

```sh
npx @deepseek-ai/dsh@0.1.5-rc.1 plugin --profile web add github:coldcanuk/deepseek_brave_plugin
~/.npm/_npx/*/node_modules/.bin/dsh plugin --profile web add github:coldcanuk/deepseek_brave_plugin
```

Do not install the `dsh` package your distribution offers (`apt install dsh`): that is an
unrelated program, not this harness.

### Updating and removing

```sh
dsh plugin --profile web update @coldcanuk/dsh-web-search-brave   # move the git pin to the current commit
dsh plugin --profile web remove @coldcanuk/dsh-web-search-brave   # uninstall; the web seam reverts to its shipped default
```

Use `update`, not a second `add`: pnpm skips resolution when the spec string is unchanged, so a
repeated `add` keeps the old commit. Both commands reconcile the bundle list on the same run.

### Other install routes

Inside this repository, plain `npm install` installs the peer packages and the one runtime
dependency; nothing here consumes the plugin by name:

```sh
npm install
npm test               # 161 tests, no key and no network required
npm run check          # every gate CI runs: tests, secrets, declarations, coverage
```

From a local clone, useful while developing a change — a path works anywhere a git spec does:

```sh
dsh plugin --profile web add /path/to/deepseek_brave_plugin   # into your profile
npm install /path/to/deepseek_brave_plugin                    # or into another project
```

> **Never install the bare npm name.** On the registry, `dsh-web-search-brave` is an unrelated
> third-party package (0.2.3, another author, MIT) whose harness peers are pinned to `^0.0.1-rc.*`.
> `npm install dsh-web-search-brave` fetches *that* package and then fails to resolve against a
> current harness. This plugin's package name is scoped: **`@coldcanuk/dsh-web-search-brave`**, and
> it is installed from this repository by git URL or path.

Both routes ship `lib/` and the `cordis.patch.yml` bundle layer; there is nothing to compile and
no postinstall step.

## Credentials

The plugin never stores a key and offers no field that accepts one. A search resolves the key once
per search, in this fixed order, and stops at the first hit:

1. `ctx.credentials.resolve(apiKeyEnv)` — the harness credential store, for example a value written
   by the settings page. Resolution being per search, a rotated key reaches the next search with no
   restart.
2. A **password manager**, when `secretManager` is not `none`: the GNOME keyring through
   `secret-tool`, then the standard Unix password manager `pass`. Neither is required, and neither
   is consulted when the store already answered.
3. The launch environment (`launchEnvironmentOf(ctx)`, layering the inherited environment, the
   invoking directory's `.env`, and the harness home's `.env`), read from the variable named by
   `apiKeyEnv` — and only when no credential provider is mounted at all.

Finding nothing raises `WEB_PROVIDER_CREDENTIAL_MISSING`, which names the reference and lists every
source that was tried.

### Password managers (recommended: no cleartext key on disk)

Store the key once under these names; the plugin looks it up with exactly the same commands.

**GNOME keyring** — one item, attribute `service=dsh-web-search-brave`:

```sh
secret-tool store --label='Brave Search API (dsh-web-search-brave)' service dsh-web-search-brave
secret-tool lookup service dsh-web-search-brave     # what the plugin runs
```

`secret-tool store` prompts for the secret itself, so it never reaches shell history or a process
list, and it creates a *password* item: the secret is the item's payload, not one of its attributes.

Create it that way rather than as a GNOME Passwords **note**. A note keeps its content in an
attribute named `secret`, and `secret-tool search` prints every attribute it finds — so
`secret-tool search --all` can print a note's contents in the clear to any process running as you,
and a "metadata only" inspection is not metadata only. The plugin never lists the collection; it
performs one `lookup` for the item it is configured for.

To point at an existing *password* item instead, name its attributes in `gnomeKeyringAttributes`:

```json
{ "gnomeKeyringAttributes": { "service": "brave-search-api", "account": "me" } }
```

Inspect a *password* item's attribute names with `secret-tool search --all <attribute> <value>` in
your desktop session; do not run it against notes.

**pass** — entry `dsh/brave-search-api`:

```sh
pass insert dsh/brave-search-api                    # prompts twice; nothing in argv
pass show dsh/brave-search-api                      # what the plugin runs; first line is the key
```

Change the entry path with `passPath`, or turn the whole step off with `secretManager: "none"`.

Every lookup is best-effort: a tool that is absent, locked, empty, or slower than 5 s yields nothing
and the chain moves on. The executable names are fixed here and never taken from configuration, calls
go through `execFile` with no shell, and no tool output is ever logged or embedded in an error.

### Without a password manager

The settings page (Settings → Plugins → Plugin configuration → Web search) stores the value in the
harness credential store: the intended route, and it needs no restart. Its `apiKeyEnv` field names
the credential and never holds the key itself — a key typed there is stored nowhere, and the failure
says so. The cleartext fallbacks are an exported variable in the launching environment, or a line in
`~/.dsh/.env` (`chmod 600`), which sits outside every repository:

```sh
export BRAVE_SEARCH_API_KEY=...   # your shell, never a repository file
```

`.env.example` lists the two recognised variable names with placeholder values.

## Configuration

Two equivalent routes:

1. **Environment** — `BRAVE_SEARCH_API_KEY` names the credential reference (change the *name* with
   `apiKeyEnv` if you prefer your own variable) and `BRAVE_SEARCH_BASE_URL` overrides the API base.
2. **Settings** — the plugin installs the settings namespace `web-search-brave`. Every field below
   is rendered by a settings UI and takes effect on the next search; no restart and no provider
   re-registration.

A composition entry passed in a profile patch is the starting value; a saved settings section
replaces it.

### Options

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `apiKeyEnv` | string, credential reference | `BRAVE_SEARCH_API_KEY` | Name of the credential holding the key. There is deliberately no literal-key field. |
| `secretManager` | `auto` \| `none` \| `gnome-keyring` \| `pass` | `auto` | Which password manager to consult besides the harness credential store. `auto` tries the GNOME keyring, then `pass`; `none` disables both. |
| `gnomeKeyringAttributes` | object of strings | `{ "service": "dsh-web-search-brave" }` | Attributes identifying the GNOME keyring item, exactly as `secret-tool lookup` receives them. |
| `passPath` | string | `dsh/brave-search-api` | Entry path inside the `pass` password store. |
| `baseURL` | string | `BRAVE_SEARCH_BASE_URL`, then `https://api.search.brave.com/res/v1` | `/res/v1` included; the mode's path is appended. Must be an absolute http(s) URL with no credentials, query, or fragment. A value that was set but is unusable is **not** replaced by the default — the provider reports itself unavailable instead, so a search fails loudly rather than going somewhere unintended. |
| `mode` | `llm-context` \| `web-search` | `llm-context` | Which endpoint answers a search. |
| `country` | string | `us` | ISO 3166-1 alpha-2 country code, e.g. `us` or `gb`. Rejected by the schema if it is not two letters. |
| `searchLang` | string | `en` | ISO 639-1 language code with an optional region, e.g. `en` or `pt-br`. Rejected by the schema otherwise. |
| `safesearch` | `off` \| `moderate` \| `strict` | unset | Unset omits the parameter, leaving Brave's default in force. |
| `freshness` | string | unset | `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`, validated by the schema — Brave answers anything else with a 422. Unset omits the parameter. |
| `count` | number, 1–50 | `20` | Clamped to 50 in `llm-context` mode and **20** in `web-search` mode. A request-level `maxResults` wins. |
| `maxTokens` | number, 1024–32768 | `8192` | `llm-context` mode only; sent as `maximum_number_of_tokens`. |
| `contextThresholdMode` | `strict` \| `balanced` \| `lenient` \| `disabled` | unset | `llm-context` mode only. Unset omits the parameter. |
| `timeoutMs` | number, >= 1 | `30000` | Per attempt, not per search. Brave recommends 30 s. |
| `maxAttempts` | number, 1–10 | `3` | Total attempts, first one included, for retryable failures. |
| `retryBaseMs` | number, 0–30000 | `250` | Base of the exponential backoff between attempts. The client caps every computed delay at 30 s, so a larger base cannot produce a longer wait. |
| `minIntervalMs` | number, 0–60000 | `0` | Minimum spacing between dispatched searches; `0` disables the client-side throttle. Bounded because the value reaches a `setTimeout`, whose 32-bit field would otherwise overflow and silently turn the spacing off. |

Values outside a numeric range are clamped into it, and enum-ish values that are not recognised
fall back to the default, so one bad field cannot disable the provider.

`baseURL` is the one option that is a **trust setting rather than a tuning knob**, because it
decides which host receives the subscription-token header. Leave it unset in production so the
Brave default applies, and set it only to a host you operate or explicitly trust — a corporate
egress proxy, or the local mock while testing. There is no compiled-in host allowlist, and
`SECURITY.md` explains what that means, which mitigations are in place (redirects are refused, the
key never enters the URL), and how to check what a running harness actually resolved.

### Parameters sent

`llm-context`: `q`, `country`, `search_lang`, `count`, `maximum_number_of_urls` (equal to the
effective count), `maximum_number_of_tokens`, plus `freshness`, `safesearch`, and
`context_threshold_mode` when configured.

`web-search`: `q`, `country`, `search_lang`, `count`, `text_decorations=false` (so descriptions
arrive as clean text rather than decorated markup), `result_filter=web`, plus `freshness` and
`safesearch` when configured.

`request.maxResults` — the tool layer sends `8` — is applied at the request layer and clamped to
the mode's ceiling, as a cost and latency optimisation. The seam still enforces the bound on the
way back.

## Response mapping

Both mappers deduplicate by URL, keeping the first occurrence, and skip entries without a usable
URL. `truncated` is always `false`: the seam owns truncation and sets that flag itself.

### `llm-context`

| Brave field | Result field | Rule |
| --- | --- | --- |
| `grounding.generic[].url` | `url` | Required; entries without one are skipped. |
| `grounding.generic[].title` | `title` | Omitted when empty. |
| `grounding.generic[].snippets[]` | `snippet` | Non-empty chunks joined with a blank line. |
| `sources[url].age[3]` | `publishedAt` | Used when it is an ISO-8601 timestamp that parses. |
| `sources[url].age[1]` | `publishedAt` | Fallback when it is a real `YYYY-MM-DD` date. |

### `web-search`

| Brave field | Result field |
| --- | --- |
| `web.results[].url` | `url` |
| `web.results[].title` | `title` |
| `web.results[].description` | `snippet` |
| `web.results[].page_age` | `publishedAt` |

### Empty versus wrong-shaped

An empty `grounding.generic` list, or a missing `web.results`, is Brave's way of saying "no
relevant content": both map to `sources: []`, which is a result, not an error.

A body that is not a JSON object, or that carries none of the expected envelope keys
(`grounding`/`sources` for LLM Context, `web`/`query` for Web Search), or that has a recognised
key with the wrong inner shape, is a `WEB_PROVIDER_ERROR`. Silently degrading an unrecognized
payload to zero results would make the seam lie about what Brave returned.

## Errors

Failures are `WebError`s from `@deepseek-ai/dsh-web` carrying one of the three shared seam codes:

| Code | Raised when |
| --- | --- |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | No key could be resolved for `apiKeyEnv`. |
| `WEB_ABORTED` | The caller's `AbortSignal` was aborted. |
| `WEB_PROVIDER_ERROR` | HTTP failure, malformed body, wrong-shaped body, timeout, refused redirect, or an exhausted retry budget. |

The recovered HTTP status and Brave's own error detail ride in the **message**, never in a custom
code — for example `Brave search API error (HTTP 401): invalid token`. Provider-specific codes are
avoided so consumers that already handle the harness's other web providers need no new branch.

## Transport behavior

- **Redirects are refused** (`redirect: 'error'`) before the target is contacted, so a
  misconfigured base URL cannot bounce a request that carries the subscription header to a third
  party. A refused redirect is not retried.
- **Timeout** — each attempt gets its own deadline (`timeoutMs`), armed on a referenced timer that is
  held for the request *and* its body read, then released as soon as the attempt settles. A caller
  cancellation surfaces as `WEB_ABORTED`; our own timeout surfaces as `WEB_PROVIDER_ERROR` naming the
  limit ("timed out after 30000 ms"). The timer is referenced rather than `AbortSignal.timeout`
  because an unreferenced timer lets Node exit while an attempt is still pending, which would surface
  as an unsettled promise instead of a timeout.
- **Retries** — `429`, `408`, any `5xx`, and transient transport failures (a dropped connection,
  a refused connection) are retried with exponential backoff: `retryBaseMs × 2^(attempt-1)`. A
  `Retry-After` header, in seconds or as an HTTP date, wins over the computed delay and is capped
  at 60 s. Other `4xx` responses are never retried: they fail identically on every attempt. The
  backoff sleep is abortable, so a cancelled search never waits it out.
- **Throttle** — dispatch is serialized through a promise chain, so concurrent searches cannot
  race each other; `minIntervalMs` additionally spaces the starts of consecutive dispatches.
- **Compression** — `accept-encoding` is not set by hand; Node's fetch negotiates it.
- **The key** is written exactly once, into the `x-subscription-token` request header. It never
  enters the URL, a log line, a session event, or an error message, and transport diagnostics are
  redacted before they are surfaced.

### Session event

Immediately before dispatch the provider records a secret-free `web/brave-search-request` session
event:

```json
{
  "provider": "brave-official",
  "endpoint": "https://api.search.brave.com/res/v1/llm/context",
  "mode": "llm-context",
  "query": "cordis plugin lifecycle",
  "params": { "q": "cordis plugin lifecycle", "country": "us", "count": 8 }
}
```

No headers, and no key. Recording is inert when no agent session is attached.

## How the install composes

A profile lives at `~/.dsh/profiles/<name>` (the built-in web profile is `web`) and is composed from
an ordered stack of bundle patch layers under the profile's own overrides. Because this package
declares `dsh.bundle.patch`, the single `add` in [Install](#install) makes its `cordis.patch.yml`
one of those layers — applied after the shipped bundles and before your profile's own
`cordis.patch.yml`, which therefore always wins. Removing the dependency removes the layer again.

The profile's package manager is already configured for out-of-tree plugins
(`nodeLinker: hoisted`, `autoInstallPeers: false`), so the `@deepseek-ai/*` peers are not duplicated
into the profile: the plugin binds to the running installation's own copies.

### What the bundled layer sets

It pins `searchProvider: brave-official`. That is required, not cosmetic: when no id is
configured and **more than one** registered provider is usable, the seam fails with
`WEB_PROVIDER_AMBIGUOUS` instead of choosing by registration order — which is exactly the
situation next to the shipped DeepSeek provider. Setting
`DSH_WEB_SEARCH_PROVIDER=brave-official` in the launch environment is equivalent.

It also restates `fetchProvider: http`, because a patch replaces the targeted row's whole
`config` rather than merging into it.

### Overriding the defaults

The profile's own `~/.dsh/profiles/web/cordis.patch.yml` is applied after every bundle layer, so
anything set there wins:

```yaml
- id: web
  config:
    searchProvider: brave-official
    fetchProvider: http      # or whatever your profile uses
```

Any other option — the mode, the country, the result count, the retry budget — is changed in
**Settings → Plugins → Plugin configuration → Web search** without touching a file.

Removing the plugin reverses the install automatically:
`dsh plugin --profile web remove @coldcanuk/dsh-web-search-brave` drops it from the layer stack,
and the `web` row falls back to the shipped defaults.

## Running the tests

```sh
npm install
npm test
```

`npm test` runs `node --test` with no file arguments, so Node's own discovery finds the suite — 161
tests across `test/config.test.js`, `test/map.test.js`, `test/client.test.js`,
`test/provider.test.js`, `test/plugin.test.js`, `test/secrets.test.js`, `test/errors.test.js`,
`test/attempt-timeout.test.js`, `test/keepalive.test.js`, and `test/check-secrets.test.js`. The
suite is hermetic: the provider tests start a real `node:http` server on an ephemeral loopback port
(`test/helpers/mock-brave.js`) and point `baseURL` at it, so no test touches the public internet,
none needs an API key, and none spawns a real `secret-tool` or `pass` (an injected `execFile` seam
stands in). The transport tests drive an injected `fetch`, so retry, timeout, and cancellation
behavior is asserted deterministically rather than by sleeping.

`npm test` then hands the runner's output to `scripts/check-test-gate.mjs`, which fails the run if
fewer than 100 tests actually executed. That guard exists because a test command can look green
while running nothing: a glob that matches no files is reported as a *vacuous success* (`tests 0`,
exit code 0) on Node 21 and newer. Use `npm run test:raw` when you want the bare `node --test`
output without the gate, and `npm run check:test-gate` to run only the gate.

Discovery is used instead of an explicit pattern on purpose. Globs in the runner's positional
arguments arrived in Node 21, while `engines` allows Node 20 — where a quoted pattern such as
`"test/**/*.test.js"` is not expanded at all, so Node looks for a file with that literal name and
the command cannot pass. A bare directory (`node --test test/`) is matched as a path and fails to
load rather than being scanned, so neither form is portable across the supported range. No-argument
discovery resolves the same files on every version. `test/keepalive.test.js` spawns child processes
to pin the related transport guarantee: a pending attempt keeps the event loop alive until its own
deadline fires, and a settled one releases its timer immediately. That guarantee is why the
per-attempt deadline uses a referenced `setTimeout` rather than `AbortSignal.timeout()`, whose timer
is unref'd: with an unref'd timer, an attempt whose transport holds no handle of its own lets Node
exit with an unsettled promise, which the suite used to observe as every later test in the file
being cancelled.

### Every gate, and what each one protects

```sh
npm test                 # discovery + the vacuous-run floor
npm run check:secrets    # the credential scan (see SECURITY.md)
npm run check:lint       # Biome, recommended rules, warnings are errors
npm run check:types      # runtime exports vs. the hand-authored .d.ts
npm run check:types:tsc  # the declarations, type-checked by tsc
npm run test:coverage    # coverage report
npm run check:coverage   # coverage report with enforced floors
npm run check            # all of the above, in order
```

`npm run check:types` is the answer to the risk that comes with hand-authored declarations:
nothing in the toolchain otherwise ties `lib/types/*.d.ts` to the `lib/*.js` beside it. It compares
the two export surfaces in both directions — a runtime export with no declaration, or a declared
value that does not exist at runtime, fails the run. It was added because the check found real
drift on its first run. `npm run check:types:tsc` uses the committed `tsconfig.json` (`noEmit`, so
nothing is ever written) to type-check the declarations themselves and the peer types they import;
it is the half that `tsc` cannot do — proving the declarations match the JavaScript — that
`check:types` covers.

`npm run check:lint` runs Biome with its recommended rules and `--error-on-warnings`, so a finding
fails the build rather than scrolling past. The formatter and the assist actions are disabled on
purpose: this tree's formatting is deliberate and a lint gate should not rewrite it. The config
excludes the style preferences the codebase deliberately does not follow (template literals over
concatenation, `console` in CLI scripts) so that the remaining rules are all real defects.

`npm run check:coverage` gates coverage rather than only reporting it. The floors (95% lines, 88%
branches, 92% functions, measured over `lib/`) sit a few points below the current baseline, so they
catch a new untested path without failing on ordinary churn.

### Continuous integration

`.github/workflows/ci.yml` runs the same commands on every push to `main`, every pull request, and
on demand: install, `npm test`, the secret scan, the lint, the declaration checks, and the coverage
floors, on Node 20, 22, and 24. The matrix covers the floor and the ceiling of the declared `engines`
range with a point in between, on the theory that a break is most likely at an edge. Dependabot keeps
dependencies moving, but a Dependabot pull request proves nothing by itself — this workflow is what
gates it. The file is short by design: it invokes the npm scripts rather than reimplementing them,
so a red check is always reproducible with the command printed above it.

`npm run check:secrets` is the credential scan. It reads exactly what `git add -A` would publish —
tracked files plus untracked files `.gitignore` does not exclude — and exits non-zero if anything
looks like a key, printing the path, the line, and the pattern name but never the matched text.
`test/check-secrets.test.js` pins the patterns against lines that must be caught
(`x-subscription-token = "..."`, `apiKey: "..."`, a bare `bsa…` value) and look-alikes that must not
be (the reference-based `apiKeyEnv` field, short placeholders).

## Package layout

```
lib/index.js       plugin entry: name, inject, Config, apply, re-exports
lib/config.js      Config schema, constants, resolveOptions
lib/errors.js      WebError helpers, abort classification, redaction
lib/map.js         pure Brave response -> WebSearchResult mappers
lib/client.js      URL building, fetch, timeout, retry, throttle
lib/provider.js    BraveSearchProvider (id, available, search)
lib/secrets.js     GNOME keyring and pass lookups for the credential
lib/types/*.d.ts   hand-authored declarations for every lib module
cordis.patch.yml   bundle patch layer: registers the provider, pins ctx.web at
                   brave-official, and ships so `dsh plugin add` composes it
tsconfig.json      no-emit config behind `npm run check:types:tsc`
biome.json         lint config behind `npm run check:lint` (formatter disabled)
scripts/           check-secrets.mjs: the credential scan behind `npm run check:secrets`
                   check-test-gate.mjs: the vacuous-test-run guard behind `npm test`
                   check-types.mjs: runtime exports vs. the .d.ts declarations
test/              node:test suite plus the mock Brave server and the fake tool runners
.github/           workflows/ci.yml: the gate that runs every one of the above on each
                   push and PR; dependabot.yml: weekly dependency updates
```

## License

GPL-3.0-or-later. See `LICENSE`.
