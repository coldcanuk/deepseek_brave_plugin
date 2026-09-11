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
  an environment variable or a credential store entry — never a value. A configured name that is not
  a valid reference name is not used as a reference; the default is used instead and the rejection is
  reported in the missing-credential message.
- **`apiKeyEnv` is still free text, and the settings document still stores what is typed into it.**
  This plugin never uses that field as a key, but it cannot stop the settings service from
  persisting the section as written — only fields the schema marks `role('secret')` are redacted
  from settings surfaces, and a reference must be readable to be useful. So a key *pasted* into that
  field is used by nothing, but it does land on disk. When the diagnostic detects that shape it says
  so and tells the operator to rotate the key; treat any key ever entered there as exposed.
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
the provider. Three routes are tried, in this fixed order, and the first hit wins:

1. `ctx.credentials.resolve(apiKeyEnv)` — the harness credential service. This is the preferred
   route: the harness owns storage, the settings UI can write it, and a rotation reaches the next
   search without a restart.
2. The configured **password manager**, when `secretManager` is not `none`: the GNOME keyring
   through `secret-tool`, then the standard Unix password manager `pass`. Each lookup runs with no
   shell, a closed binary set, a 5 s timeout, and a bounded output size (see *How the key is used*).
   Neither tool is required, and neither is consulted once the store has answered.
3. The launch environment snapshot, read from the variable named by `apiKeyEnv` (default
   `BRAVE_SEARCH_API_KEY`) — and only when no credential provider is mounted at all. An empty or
   whitespace-only value counts as absent.

Finding nothing raises `WEB_PROVIDER_CREDENTIAL_MISSING`, whose message names the *reference*, never a
value, and lists every source that was tried.

## How the key is used

- It is written to exactly one place: the `X-Subscription-Token` request header of a request to
  the configured Brave base URL. It is never placed in a URL, a query parameter, or a request body.
- The *value* never appears in a log line, a session event, or an error message — not as text, and
  the transport diagnostics that could carry it (Brave's error detail, a network failure's message)
  pass through a redaction step that removes any occurrence of the resolved value. The pre-dispatch
  session event `web/brave-search-request` records the endpoint, mode, query, and non-secret
  parameters only; a test asserts the key cannot appear in it. The credential *reference* is named
  in diagnostics on purpose — an operator cannot fix a typo they are not shown — with a value that
  merely looks like a key replaced by a placeholder.
- Transport diagnostics (Brave's error detail, a network failure's message) pass through a
  redaction step that removes any occurrence of the resolved value before the text is surfaced.
  Tests cover this for both an HTTP error body and a network-level failure.
- Redirects are refused (`redirect: 'error'`) so a request carrying the header cannot be bounced
  to another origin by a compromised or misconfigured base URL.
- The secret-manager lookups run a closed set of binaries (`secret-tool`, `pass`) with no shell, a
  5 s timeout, a bounded argument count, and a bounded output size. Tool output is never surfaced:
  a failure becomes a fixed, secret-free note naming the tool and the reason.
- `available()` is local: it never contacts Brave and never reads a credential, so provider
  selection cannot leak timing information about key presence.
- The only outbound network call this plugin ever makes is the search request to the configured
  Brave base URL. There is no telemetry, no analytics, and no other endpoint.

## The `baseURL` trust boundary

`baseURL` (and the `BRAVE_SEARCH_BASE_URL` variable that seeds it) decides which host receives the
`X-Subscription-Token` header. It is therefore a **trust setting, not a tuning knob**: the operator
who can set it can direct the key at a host they control.

The mitigations that are in place:

- Redirects are refused (`redirect: 'error'`), and a refused redirect is classified as permanent, so
  the attempt is never retried. A host cannot answer with a `3xx` and collect the header at a second
  origin.
- The key travels only in a request header, never in the URL, so a redirect target or an access log
  on the way cannot pick it up from the request line.
- The base URL is never read from a search request. It comes from the settings section or the launch
  environment, both of which are operator-controlled, so an agent-driven search cannot retarget it.
- A configured value is accepted only when it is an absolute `http`/`https` URL with no embedded
  credentials, no query string, and no fragment. Those are rejected because they either put a secret
  into the request-URL position, put one into the recorded request event, or break the endpoint path
  the provider appends. A rejected value is **not** silently replaced by the Brave default — that
  would send the token to a host the operator did not choose. It is kept as configured, which makes
  the provider report itself unavailable, so a search fails loudly instead of quietly going
  somewhere unintended.

What is deliberately **not** enforced, and what that means for an operator:

- There is no compiled-in allowlist of permitted hosts. A hard-coded list would make the local mock
  server used by the test suite unreachable and would block a legitimate proxy or an on-premise
  gateway. The provider also cannot distinguish a deliberate mirror from an injected value.
- So the setting is as trusted as the settings file and the launch environment themselves. Anyone
  who can write either can already read the credential by other means; treat both as secret-bearing.

Guidance for a production harness: leave `baseURL` unset so the default
`https://api.search.brave.com/res/v1` is used. Set it **only** to a host you operate or explicitly
trust — a corporate egress proxy, or a local mock while testing — and set it through the settings
section rather than a shared environment file, so the value is visible in the place the operator
already reviews. Confirm what a running harness actually resolved before trusting it:

```sh
grep -R "baseURL" ~/.config/dsh ~/.dsh 2>/dev/null   # wherever this profile keeps its settings
printenv BRAVE_SEARCH_BASE_URL                        # an environment value overrides your intent
```

If the resolved value is not a host you recognise, treat the credential as exposed and rotate it in
the Brave dashboard (see *Rotation and revocation* below).

## Rotation and revocation

Rotate by replacing the value behind the configured reference — update the credential service entry
or restart with a new environment value. Because the key is resolved per search, the next search
uses the new value; no plugin change or provider re-registration is involved. Revoke a leaked key
in the Brave dashboard; nothing in this repository needs to change.

## Supported versions

The latest released major version receives security fixes.
