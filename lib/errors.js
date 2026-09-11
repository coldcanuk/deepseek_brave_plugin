// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Error vocabulary, abort classification, and redaction for the Brave search
 * provider.
 *
 * Every failure this plugin raises is a {@link WebError} carrying one of the
 * three shared seam codes, so a consumer that already routes the harness's other
 * web providers needs no provider-specific branch:
 *
 * - {@link WEB_PROVIDER_CREDENTIAL_MISSING} — no key could be resolved.
 * - {@link WEB_ABORTED} — the caller cancelled.
 * - {@link WEB_PROVIDER_ERROR} — everything else (HTTP failure, malformed body,
 *   timeout, transport failure).
 *
 * The recovered HTTP status and Brave's own error detail ride in the *message*,
 * never in a custom code. Redaction helpers exist so a failure path can surface
 * diagnostic text without ever echoing a credential.
 *
 * @module dsh-web-search-brave/errors
 */
import { WebError } from '@deepseek-ai/dsh-web';

/** Shared seam code: no credential could be resolved for the configured reference. */
export const WEB_PROVIDER_CREDENTIAL_MISSING = 'WEB_PROVIDER_CREDENTIAL_MISSING';
/** Shared seam code: the caller cancelled the search. */
export const WEB_ABORTED = 'WEB_ABORTED';
/** Shared seam code: every other provider failure. */
export const WEB_PROVIDER_ERROR = 'WEB_PROVIDER_ERROR';

/** Text substituted for a credential found in a string that is about to be surfaced. */
export const REDACTED = '[redacted]';

/**
 * Shortest value worth scanning for. Below this length a "secret" is as likely
 * to appear as an ordinary substring, and blind replacement would mangle
 * diagnostics without protecting anything real.
 */
export const MIN_REDACTABLE_LENGTH = 8;

/**
 * Whether a caught value is an abort. Matches the `DOMException` Node's
 * `AbortSignal` and `fetch` produce, and any error that carries the same name.
 * @param error - the caught value.
 * @returns true when the value is an abort error.
 */
export function isAbortError(error) {
  return error !== null && typeof error === 'object' && error.name === 'AbortError';
}

/**
 * Remove every occurrence of each secret from a string.
 * @param text - the text to sanitize.
 * @param secrets - credential values that must never be surfaced; values shorter
 *   than {@link MIN_REDACTABLE_LENGTH} are ignored, as are non-strings.
 * @returns the sanitized text.
 */
export function redact(text, secrets) {
  let out = String(text);
  if (!Array.isArray(secrets)) return out;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < MIN_REDACTABLE_LENGTH) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Render a caught value as one redacted diagnostic line.
 * @param error - the caught value.
 * @param secrets - credential values that must never be surfaced.
 * @returns a short, non-empty, redacted description.
 */
export function describeError(error, secrets) {
  const base = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redact(base, secrets);
}

/**
 * Build the provider's generic failure. Use this for everything that is not a
 * missing credential or a caller cancellation, so the code stays in the shared
 * seam vocabulary while the message carries the useful detail.
 * @param message - failure description, including any recovered HTTP status.
 * @param options - optional `cause` (the underlying error) and `secrets`
 *   (credential values to strip from the message before it is surfaced).
 * @returns the typed seam error.
 */
export function providerError(message, options = {}) {
  const { cause, secrets } = options;
  return new WebError(redact(message, secrets), WEB_PROVIDER_ERROR, cause === undefined ? undefined : { cause });
}

/**
 * Build the provider's stable cancellation error while retaining the caller's
 * abort reason when `signal.reason` carries one.
 * @param signal - the caller's signal, when one was supplied.
 * @param fallback - the error that surfaced the cancellation, when there is one.
 * @returns the `WEB_ABORTED` seam error.
 */
export function searchAborted(signal, fallback) {
  const reason = signal !== undefined && signal.aborted === true && signal.reason !== undefined ? signal.reason : fallback;
  return new WebError('Brave search aborted by the caller', WEB_ABORTED, reason === undefined ? undefined : { cause: reason });
}

/**
 * Throw {@link searchAborted} when the caller already cancelled. Called at each
 * await boundary so cancellation is never lost behind a long retry chain.
 * @param signal - the caller's signal, when one was supplied.
 */
export function throwIfSearchAborted(signal) {
  if (signal !== undefined && signal.aborted === true) throw searchAborted(signal);
}

/**
 * Prefixes and shapes of issued credentials, plus the generic shapes a pasted
 * secret takes: a long unbroken run of token characters, or a JWT. This is a
 * denylist, so it cannot be complete by construction — a value it does not
 * recognize is still withheld, because {@link looksLikePastedKey} also rejects
 * anything that is not shaped like a name.
 */
const KEY_SHAPE_PATTERNS = [
  // Vendor-issued prefixes, including Brave's own.
  /^(?:bsa|akia|asia|aiza|ya29|gh[pousr]_|github_pat_|glpat-|sk-|sk_live_|sk_test_|pk_live_|xox[abprs]-|npm_|pypi-|hf_|dop_v1_|shpat_|SG\.|AIza|EAACEdEose0cBA)/iu,
  // A long unbroken run of token characters, or a JWT: never a credential name.
  /^[A-Za-z0-9+/=_-]{24,}$/u,
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./u,
];

/**
 * Whether a configured value looks like a credential rather than the name of
 * one. Two independent signals are enough: it carries a known credential prefix,
 * or it is not shaped like the reference-name it is supposed to be.
 * @param value - the configured reference.
 * @returns true when the value must not be echoed into a diagnostic.
 */
export function looksLikePastedKey(value) {
  const raw = String(value);
  if (raw.length === 0) return false;
  if (KEY_SHAPE_PATTERNS.some((pattern) => pattern.test(raw))) return true;
  // A reference names a value, so it has words separated by `_` or `-`. A value
  // with no separator at all is a name only by coincidence, and one longer than a
  // name plausibly is not a name.
  return !/[_-]/u.test(raw) && raw.length > 16;
}

/**
 * Render a configured credential reference for a diagnostic without echoing a
 * value that could be the credential itself. `apiKeyEnv` is a name in the
 * intended configuration, but it is a free-text field in practice, so a pasted
 * key can end up in it; a message carrying that value would be read by the model
 * and written to the session log.
 *
 * The rule withholds anything it cannot positively recognize as a reference
 * name. It is a heuristic, not a guarantee. What makes the guarantee is that the
 * places the key is really looked for report through `attempted`, whose notes are
 * built from known strings and never from a resolved value.
 * @param value - the configured reference.
 * @returns the reference, or a placeholder when it might be a key.
 */
export function safeCredentialLabel(value) {
  const raw = String(value);
  if (raw.length === 0) return '(empty)';
  return looksLikePastedKey(raw) ? 'a value that looks like a key rather than a name' : raw;
}

/**
 * Build the missing-credential failure. The message names the reference and the
 * three ways a user can supply a value; it can never contain the value itself,
 * because at this point none was resolved.
 * @param apiKeyEnv - the credential reference that resolved to nothing; when it
 *   might be the key itself, it is described but never echoed.
 * @param attempted - secret-free notes for each source that was tried, in order.
 * @returns the `WEB_PROVIDER_CREDENTIAL_MISSING` seam error.
 */
export function credentialMissingError(apiKeyEnv, attempted) {
  const raw = String(apiKeyEnv);
  const misconfigured = looksLikePastedKey(raw);
  const label = misconfigured ? 'the configured credential reference (it looks like a key, not a name)' : '"' + raw + '"';
  const named = misconfigured ? 'that reference' : raw;
  const hint = misconfigured
    ? ' The apiKeyEnv setting appears to hold the key itself; it must hold the credential name. The settings service persists what was typed into that field, so treat a key entered there as exposed and rotate it.'
    : '';
  const tried = Array.isArray(attempted) && attempted.length > 0 ? ' Where the key was looked for, in order: ' + attempted.join('; ') + '.' : '';
  return new WebError(
    `Brave search has no API key for ${label}. Store the value for that reference through the harness credentials service (Settings > Plugins > Plugin configuration > Web search), put it in the GNOME keyring or pass (see README), export ${named} in the environment that launches the harness, or put it in the harness home's .env file. The apiKeyEnv setting names the credential and never supplies one, so a key typed into that field is not used for a search.${hint}${tried}`,
    WEB_PROVIDER_CREDENTIAL_MISSING,
  );
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort, so a later rejection cannot become unhandled.
 *
 * That guarantee has to hold on the already-aborted path too. Returning a
 * rejected promise without attaching a handler left the caller's in-flight
 * operation fully unobserved, and a rejection from it later surfaced as an
 * unhandled rejection — which Node's test runner, and any harness that treats one
 * as fatal, reports against whatever happens to be running at the time. The
 * observation is attached first, then the rejection is returned.
 * @param operation - the preflight to run.
 * @param signal - the caller's signal, when one was supplied.
 * @returns the operation's value, or a rejection when the caller aborted first.
 */
export function abortable(operation, signal) {
  if (signal === undefined) return operation;
  /** Observe settlement of a promise nobody is going to await. */
  const observe = (promise) => {
    promise.then(
      () => {},
      () => {},
    );
  };
  if (signal.aborted === true) {
    observe(operation);
    return Promise.reject(searchAborted(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(searchAborted(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
