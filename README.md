# dsh-web-search-brave

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that registers the
**Brave Search API** as a search provider in the harness web capability seam (`ctx.web`), so the
model-facing `web_search` tool is answered by Brave instead of by the harness's built-in search.

- **No build step.** `lib/` is hand-authored ESM plus hand-authored `.d.ts`. What is committed is
  what runs.
- **No runtime dependencies** beyond `@deepseek-ai/schemastery`; everything else is a peer.
- **No key material in this repository, ever.** Configuration carries a credential *reference*;
  the value is resolved once per search from the harness credential service or the launch
  environment and travels only in the `X-Subscription-Token` request header.

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

- Node.js **20.3 or newer** (`engines` declares `>=20`; the 20.3 floor is `AbortSignal.any`, used
  to combine the caller's cancellation with the per-attempt timeout).
- A harness that provides `@deepseek-ai/dsh-web`, `@deepseek-ai/dsh-credentials`,
  `@deepseek-ai/dsh-launch-environment`, `@deepseek-ai/dsh-settings`, and `@deepseek-ai/cordis`
  (declared as peer dependencies).
- A Brave Search API subscription key with access to the endpoint you choose. Both modes are on
  the same "Search" plan and use the same key.

## Install

> **Do not install the bare name.** `dsh-web-search-brave` is taken on npm by an unrelated
> third-party package (currently 0.2.3, another author, MIT) whose harness peers are pinned to
> `^0.0.1-rc.*`. `npm install dsh-web-search-brave` fetches *that* package, not this one, and then
> fails to resolve against a current harness. This plugin's package name is scoped:
> **`@coldcanuk/dsh-web-search-brave`**.

Install from this repository, by git URL or by path:

```sh
npm install github:coldcanuk/deepseek_brave_plugin
# or, from a local clone:
npm install /path/to/deepseek_brave_plugin
```

Inside a harness profile, name it in the profile's `dependencies` (see
[Adding it to a harness profile](#adding-it-to-a-harness-profile)):

```json
{
  "dependencies": {
    "@coldcanuk/dsh-web-search-brave": "github:coldcanuk/deepseek_brave_plugin"
  }
}
```

Inside this repository, plain `npm install` is all you need: it installs the peer packages and the
single runtime dependency. Nothing here consumes the plugin by name, so do not run the bare-name
install in this directory — it would add the unrelated registry package to this manifest.

The package ships `lib/` only; there is nothing to compile and no postinstall step.

## Credentials

The plugin never stores a key and offers no field that accepts one. A search resolves the key, in
this order:

1. `ctx.credentials.resolve(apiKeyEnv)` — the harness credential service, for example a value
   written by a settings UI or a credential file. Resolution happens once per search, so a rotated
   key reaches the next search with no restart.
2. The launch environment (`launchEnvironmentOf(ctx)`, which layers the inherited environment, the
   invoking directory's `.env`, and the harness home's `.env`), read from the variable named by
   `apiKeyEnv`.

If neither yields a non-empty value the search fails with
`WEB_PROVIDER_CREDENTIAL_MISSING` naming the reference. (An empty ambient value counts as absent;
the credential service is authoritative when it is registered, and there is no silent fallback
from it to the environment.)

The quickest local setup is an exported variable in the environment that launches the harness:

```sh
export BRAVE_SEARCH_API_KEY=...   # your key, in your shell, never in this repository
```

`.env.example` in this repository lists the two recognised variable names with placeholder values.

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
| `baseURL` | string | `BRAVE_SEARCH_BASE_URL`, then `https://api.search.brave.com/res/v1` | `/res/v1` included; the mode's path is appended. |
| `mode` | `llm-context` \| `web-search` | `llm-context` | Which endpoint answers a search. |
| `country` | string | `us` | ISO 3166-1 alpha-2 country code. |
| `searchLang` | string | `en` | ISO 639-1 language code. |
| `safesearch` | `off` \| `moderate` \| `strict` | unset | Unset omits the parameter, leaving Brave's default in force. |
| `freshness` | string | unset | `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`. Unset omits the parameter. |
| `count` | number, 1–50 | `20` | Clamped to 50 in `llm-context` mode and **20** in `web-search` mode. A request-level `maxResults` wins. |
| `maxTokens` | number, 1024–32768 | `8192` | `llm-context` mode only; sent as `maximum_number_of_tokens`. |
| `contextThresholdMode` | `strict` \| `balanced` \| `lenient` \| `disabled` | unset | `llm-context` mode only. Unset omits the parameter. |
| `timeoutMs` | number, >= 1 | `30000` | Per attempt, not per search. Brave recommends 30 s. |
| `maxAttempts` | number, 1–10 | `3` | Total attempts, first one included, for retryable failures. |
| `retryBaseMs` | number, >= 0 | `250` | Base of the exponential backoff between attempts. |
| `minIntervalMs` | number, >= 0 | `0` | Minimum spacing between dispatched searches; `0` disables the client-side throttle. |

Values outside a numeric range are clamped into it, and enum-ish values that are not recognised
fall back to the default, so one bad field cannot disable the provider.

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
- **Timeout** — each attempt gets its own `AbortSignal.timeout(timeoutMs)`. A caller cancellation
  surfaces as `WEB_ABORTED`; our own timeout surfaces as `WEB_PROVIDER_ERROR` naming the limit
  ("timed out after 30000 ms").
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

## Adding it to a harness profile

A profile lives at `~/.dsh/profiles/<name>` (the built-in web profile is `web`) and is composed
from the shipped bundle layers plus your own `cordis.patch.yml`.

**1. Add the package to the profile.** Either edit
`~/.dsh/profiles/web/package.json` and add it to `dependencies`:

```json
{
  "dependencies": {
    "@coldcanuk/dsh-web-search-brave": "github:coldcanuk/deepseek_brave_plugin"
  }
}
```

and install in that directory (`pnpm install`), or let the CLI forward the same git spec to the
profile's package manager:

```sh
dsh plugin --profile web add github:coldcanuk/deepseek_brave_plugin
```

Install by git URL or path, never by the bare name: the registry's `dsh-web-search-brave` is a
different package (see [Install](#install)).

**2. Add a patch entry** to `~/.dsh/profiles/web/cordis.patch.yml`. A patch can insert rows, and
rows that do not exist yet must be inserted:

```yaml
- insert:
    - id: web-search-brave
      name: '@coldcanuk/dsh-web-search-brave'
      config:
        apiKeyEnv: BRAVE_SEARCH_API_KEY
```

**3. Point the `web` seam at it.** A patch replaces the targeted row's whole `config`, so restate
your existing `fetchProvider` (and anything else that row carries):

```yaml
- id: web
  config:
    searchProvider: brave-official
    fetchProvider: http
```

Pinning `searchProvider` is required, not cosmetic: the seam resolves a provider at execution
time, and when no id is configured and **more than one** registered provider is usable it fails
with `WEB_PROVIDER_AMBIGUOUS` rather than picking by registration order. Registering this plugin
next to the shipped DeepSeek provider is exactly that situation. Setting
`DSH_WEB_SEARCH_PROVIDER=brave-official` in the launch environment is equivalent to the `web`
row's `searchProvider`.

Finally, supply the key (export `BRAVE_SEARCH_API_KEY`, or store it through the credentials
service) and restart the harness.

## Running the tests

```sh
npm install
npm test
```

`npm test` runs `node --test "test/**/*.test.js"` — 92 tests across
`test/config.test.js`, `test/map.test.js`, `test/client.test.js`, `test/provider.test.js`, and
`test/plugin.test.js`. The suite is hermetic: the provider tests start a real `node:http` server on
an ephemeral loopback port (`test/helpers/mock-brave.js`) and point `baseURL` at it, so no test
touches the public internet and none needs an API key. The transport tests drive an injected
`fetch`, so retry, timeout, and cancellation behavior is asserted deterministically rather than by
sleeping.

The script names the test files explicitly because Node 22 and newer treat positional arguments to
`node --test` as glob patterns; a bare directory (`node --test test/`) is matched as a path and
fails to load instead of being scanned.

## Package layout

```
lib/index.js       plugin entry: name, inject, Config, apply, re-exports
lib/config.js      Config schema, constants, resolveOptions
lib/errors.js      WebError helpers, abort classification, redaction
lib/map.js         pure Brave response -> WebSearchResult mappers
lib/client.js      URL building, fetch, timeout, retry, throttle
lib/provider.js    BraveSearchProvider (id, available, search)
lib/types/*.d.ts   hand-authored declarations for every lib module
test/              node:test suite plus the mock Brave server
```

## License

GPL-3.0-or-later. See `LICENSE`.
