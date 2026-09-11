// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Error vocabulary, abort classification, and redaction.
 * @module dsh-web-search-brave/errors
 */
import { WebError } from '@deepseek-ai/dsh-web';

/** Shared seam code: no credential could be resolved for the configured reference. */
export declare const WEB_PROVIDER_CREDENTIAL_MISSING = "WEB_PROVIDER_CREDENTIAL_MISSING";
/** Shared seam code: the caller cancelled the search. */
export declare const WEB_ABORTED = "WEB_ABORTED";
/** Shared seam code: every other provider failure. */
export declare const WEB_PROVIDER_ERROR = "WEB_PROVIDER_ERROR";
/** Text substituted for a credential found in a string that is about to be surfaced. */
export declare const REDACTED = "[redacted]";
/** Shortest value worth scanning for. */
export declare const MIN_REDACTABLE_LENGTH = 8;

/** Whether a caught value is an abort. */
export declare function isAbortError(error: unknown): boolean;
/** Remove every occurrence of each secret from a string. */
export declare function redact(text: unknown, secrets?: readonly unknown[]): string;
/** Render a caught value as one redacted diagnostic line. */
export declare function describeError(error: unknown, secrets?: readonly unknown[]): string;
/** Build the provider's generic `WEB_PROVIDER_ERROR` failure. */
export declare function providerError(message: string, options?: {
    cause?: unknown;
    secrets?: readonly string[];
}): WebError;
/** Build the provider's stable `WEB_ABORTED` cancellation error. */
export declare function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError;
/** Throw {@link searchAborted} when the caller already cancelled. */
export declare function throwIfSearchAborted(signal?: AbortSignal): void;
/** Build the `WEB_PROVIDER_CREDENTIAL_MISSING` failure naming the reference. */
export declare function credentialMissingError(apiKeyEnv: unknown): WebError;
/** Race an asynchronous preflight against caller cancellation. */
export declare function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T>;
