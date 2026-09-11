// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Transport: URL construction, one GET with a per-attempt timeout, bounded
 * retries with exponential backoff, and an optional client-side throttle.
 * @module dsh-web-search-brave/client
 */
import type { BraveSearchProviderOptions } from './config.js';

/** Longest `Retry-After` this client will honor. */
export declare const MAX_RETRY_AFTER_MS = 60000;
/** Longest computed backoff delay. */
export declare const MAX_RETRY_DELAY_MS = 30000;
/** Longest Brave error detail copied into a message. */
export declare const MAX_ERROR_DETAIL_LENGTH = 300;
/**
 * Header carrying the subscription token; the one and only place the key leaves
 * this plugin.
 */
export declare const SUBSCRIPTION_TOKEN_HEADER = "x-subscription-token";

/** One request's endpoint and non-secret parameters. */
export interface BraveQuery {
    /** The endpoint URL, without its query string. */
    readonly endpoint: string;
    /** Ordered, JSON-safe query parameters. */
    readonly params: Readonly<Record<string, string | number>>;
}
/** The part of a search request the transport reads. */
export interface BraveSearchRequestLike {
    readonly query: string;
    readonly maxResults?: number;
}
/** Injectable transport seams. */
export interface BraveTransportDependencies {
    /** Fetch implementation; defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
    /** Abortable sleep; defaults to `sleepMs`. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Clock; defaults to `Date.now`. */
    now?: () => number;
}

/** Append an endpoint path to a base URL, tolerating trailing slashes. */
export declare function joinUrl(baseURL: string, path: string): string;
/** Build one search's endpoint and non-secret query parameters. */
export declare function buildQuery(options: BraveSearchProviderOptions, request: BraveSearchRequestLike): BraveQuery;
/** Render an endpoint and its parameters as a request URL. */
export declare function buildUrl(endpoint: string, params: Readonly<Record<string, string | number | undefined>>): string;
/** Parse a `Retry-After` header in either its seconds or HTTP-date form. */
export declare function parseRetryAfter(value: string | null | undefined, nowMs?: number): number | undefined;
/** Delay before the next attempt. */
export declare function retryDelayMs(attempt: number, retryAfterMs: number | undefined, retryBaseMs: number): number;
/** Whether a status is worth another attempt. */
export declare function isRetryableStatus(status: number): boolean;
/** Whether a caught fetch rejection came from refusing a redirect. */
export declare function isRedirectError(error: unknown): boolean;
/** Sleep, honoring cancellation. */
export declare function sleepMs(ms: number, signal?: AbortSignal): Promise<void>;

/** One attempt's deadline: its signal, a timeout predicate, and a disposer. */
export interface AttemptDeadline {
    /** Signal that aborts when the deadline elapses. */
    readonly signal: AbortSignal;
    /** Whether this deadline is what aborted the attempt. */
    didTimeOut(): boolean;
    /** Clear the underlying timer; safe to call more than once. */
    dispose(): void;
}
/**
 * Start one attempt's deadline on a referenced timer, so an attempt whose
 * transport holds no handle of its own still keeps the process alive until the
 * timeout fires. Call `dispose()` once the attempt settles.
 */
export declare function attemptTimeout(timeoutMs: number): AttemptDeadline;

/** Serializes dispatch through a promise chain and enforces a minimum interval. */
export declare class RequestThrottle {
    constructor(options?: {
        now?: () => number;
    });
    /** Queue one dispatch behind every previously queued one. */
    schedule<T>(operation: () => Promise<T>, options?: {
        minIntervalMs?: number;
        signal?: AbortSignal;
        sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    }): Promise<T>;
}
/** Perform one search request, retrying retryable failures. */
export declare function fetchSearch(input: {
    url: string;
    apiKey: string;
    options: BraveSearchProviderOptions;
    signal?: AbortSignal;
    deps?: BraveTransportDependencies;
}): Promise<unknown>;
