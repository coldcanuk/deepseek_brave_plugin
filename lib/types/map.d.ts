// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Pure response mappers: a parsed Brave JSON body in, a normalized search result out.
 * @module dsh-web-search-brave/map
 */
import type { WebSearchResult } from '@deepseek-ai/dsh-web';
import type { BraveSearchMode } from './config.js';

/** Publication time from one Brave `sources[url].age` array. */
export declare function publishedAtFromAge(age: unknown): string | undefined;
/** Map an LLM Context response. */
export declare function mapLlmContextResponse(payload: unknown): WebSearchResult;
/** Map a Web Search response. */
export declare function mapWebSearchResponse(payload: unknown): WebSearchResult;
/** Map a payload with the mapper belonging to `mode`. */
export declare function mapResponse(mode: BraveSearchMode, payload: unknown): WebSearchResult;
/** The mapper each mode uses. */
export declare const MAPPER_BY_MODE: Readonly<Record<BraveSearchMode, (payload: unknown) => WebSearchResult>>;
