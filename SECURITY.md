# Security policy

## Reporting a vulnerability

Please report privately, not in a public issue:

- Open a draft advisory at
  <https://github.com/coldcanuk/deepseek_brave_plugin/security/advisories/new>, or
- email the maintainer at the address in `git log -1 --format=%ae`.

Include the version, the harness version, what you did, and what happened. You can expect an
acknowledgement within a few days. Please give a fix and a release a reasonable window before
disclosing publicly.

## This repository contains no secrets

The repository is public and holds no credential of any kind. In particular:

- There is no `.env` file. `.env.example` contains the placeholder text `your-key-here` and is
  tracked on purpose so the two recognised variable names are discoverable.
- The configuration schema has **no literal-key field**. `apiKeyEnv` is a *reference* — the name of
  an environment variable or a credential store entry — and a value that is not a valid reference
  name falls back to the default rather than being stored.
- No test, fixture, or log line carries a usable key. The test suite points the provider at a local
  `node:http` server and uses an obviously fake fixture value; it passes with no key at all.
- `.gitignore` excludes `.env`, `.env.*` (with `.env.example` re-included), `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `*.secret`, `credentials.json`, `secrets.json`, and `.dsh/`.
- The claim is checked rather than asserted: `npm run check:secrets` inspects every
  commit-eligible file — tracked, plus untracked files `.gitignore` does not exclude, i.e. exactly
  what `git add -A` would publish — for Brave tokens, subscription-token assignments, quoted
  API-key assignments, AWS access-key ids, GitHub and OpenAI-style tokens, and PEM private keys. It
  prints the path, the line, and the pattern name, and never the matched text: a finding must not
  leak what it found. Run it before every push; it exits non-zero on anything.

## Install source: verify it

The bare npm registry name `dsh-web-search-brave` belongs to an **unrelated third-party package**
(currently 0.2.3, another author, MIT) whose harness peers are pinned to `^0.0.1-rc.*`. This plugin
is named `@coldcanuk/dsh-web-search-brave` and is normally installed from this repository by git
URL or by path.

Install by git URL or path, then check what you actually got:

```sh
npm ls @coldcanuk/dsh-web-search-brave
node -e "console.log(require.resolve('@coldcanuk/dsh-web-search-brave/package.json'))"
```

This matters because a search provider runs inside the harness: it receives every search query the
agent issues and it resolves the credential named by `apiKeyEnv`. Installing the wrong package
hands both to that package. If a dependency tree resolves the bare name, remove it and install this
repository instead.

## Credential model

A Brave Search API key is resolved **once per search**, never at plugin load and never cached on
the provider:

1. `ctx.credentials.resolve(apiKeyEnv)` — the harness credential service. This is the preferred
   route: the harness owns storage, the settings UI can write it, and a rotation reaches the next
   search without a restart.
2. The launch environment snapshot, read from the variable named by `apiKeyEnv` (default
   `BRAVE_SEARCH_API_KEY`). An empty value counts as absent.

If neither yields a value the search fails with `WEB_PROVIDER_CREDENTIAL_MISSING`, whose message
names the *reference*, never a value.

## How the key is used

- It is written to exactly one place: the `X-Subscription-Token` request header of a request to
  the configured Brave base URL. It is never placed in a URL, a query parameter, or a request body.
- It is never logged, never written to a session event, and never embedded in an error message.
  The pre-dispatch session event `web/brave-search-request` records the endpoint, mode, query, and
  non-secret parameters only; a test asserts the key cannot appear in it.
- Transport diagnostics (Brave's error detail, a network failure's message) pass through a
  redaction step that removes any occurrence of the resolved value before the text is surfaced.
  Tests cover this for both an HTTP error body and a network-level failure.
- Redirects are refused (`redirect: 'error'`) so a request carrying the header cannot be bounced
  to another origin by a compromised or misconfigured base URL.
- `available()` is local: it never contacts Brave and never reads a credential, so provider
  selection cannot leak timing information about key presence.
- The only outbound network call this plugin ever makes is the search request to the configured
  Brave base URL. There is no telemetry, no analytics, and no other endpoint.

## Rotation and revocation

Rotate by replacing the value behind the configured reference — update the credential service entry
or restart with a new environment value. Because the key is resolved per search, the next search
uses the new value; no plugin change or provider re-registration is involved. Revoke a leaked key
in the Brave dashboard; nothing in this repository needs to change.

## Supported versions

The latest released major version receives security fixes.
