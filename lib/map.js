// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Pure response mappers: a parsed Brave JSON body in, a normalized
 * {@link WebSearchResult} out. No I/O, no configuration, no ambient state, so
 * every mapping rule is directly testable.
 *
 * Two envelopes are supported:
 *
 * - `llm-context` — `grounding.generic[]` carries url/title/snippets, and the
 *   sibling `sources` index carries publication ages keyed by URL.
 * - `web-search` — `web.results[]` carries url/title/description/page_age.
 *
 * Both mappers treat an empty result set as a legitimate answer and a
 * wrong-shaped body as an error. Silently degrading an unrecognized payload to
 * zero results would make the seam lie about what Brave returned.
 *
 * @module dsh-web-search-brave/map
 */
import { MODE_LLM_CONTEXT, MODE_WEB_SEARCH } from './config.js';
import { providerError } from './errors.js';

/** A full ISO-8601 timestamp, as Brave writes `age[3]`. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** A bare calendar date, as Brave writes `age[1]`. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a value is a JSON object (not null, not an array).
 * @param value - the candidate.
 * @returns true for a plain object-shaped value.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A non-empty string, or `undefined` — optional fields are omitted, never invented. */
function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The received value's shape, for a diagnostic that names what actually arrived. */
function describeShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  if (typeof value === 'object') return 'an object';
  return typeof value;
}

/** An ISO-8601 timestamp, or `undefined` when the value is absent or unparseable. */
function isoDateTime(value) {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

/** A `YYYY-MM-DD` calendar date, or `undefined` when absent or not a real date. */
function calendarDate(value) {
  if (typeof value !== 'string' || !CALENDAR_DATE.test(value)) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

/**
 * Publication time from one Brave `sources[url].age` array: the ISO-8601
 * timestamp at index 3 wins, and the calendar date at index 1 is the fallback.
 * @param age - the `age` array, when the index carries one.
 * @returns the ISO-8601 string to report, or `undefined`.
 */
export function publishedAtFromAge(age) {
  if (!Array.isArray(age)) return undefined;
  return isoDateTime(age[3]) ?? calendarDate(age[1]);
}

/** Assemble one source, omitting every field Brave did not supply. */
function source(url, title, snippet, publishedAt) {
  return {
    url,
    ...(title !== undefined ? { title } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

/**
 * Map an LLM Context response. Grounding entries missing a usable URL are
 * skipped; the first occurrence of a URL wins.
 * @param payload - the parsed response body.
 * @returns the normalized result; `sources` may be empty.
 * @throws {WebError} `WEB_PROVIDER_ERROR` when the body is not a recognizable
 *   LLM Context envelope.
 */
export function mapLlmContextResponse(payload) {
  if (!isRecord(payload)) {
    throw providerError(`Brave LLM Context response was not a JSON object (received ${describeShape(payload)})`);
  }
  // `grounding` is the envelope that identifies this payload. Its presence is
  // required rather than inferred from `sources`: every successful LLM Context
  // response carries it, an empty `grounding` is a legitimate no-results answer,
  // and accepting a stray `sources` field instead made any unrelated JSON body
  // that happened to use that key look like an empty result set rather than the
  // wrong-shaped body it is.
  if (!('grounding' in payload)) {
    throw providerError('Brave LLM Context response carried no "grounding" envelope; this is not an LLM Context payload');
  }
  const grounding = payload.grounding;
  if (grounding !== undefined && !isRecord(grounding)) {
    throw providerError(`Brave LLM Context response carried a "grounding" field that was not an object (received ${describeShape(grounding)})`);
  }
  const generic = grounding === undefined ? undefined : grounding.generic;
  if (generic !== undefined && !Array.isArray(generic)) {
    throw providerError(`Brave LLM Context response carried a "grounding.generic" field that was not an array (received ${describeShape(generic)})`);
  }
  const index = payload.sources;
  if (index !== undefined && !isRecord(index)) {
    throw providerError(`Brave LLM Context response carried a "sources" field that was not an object (received ${describeShape(index)})`);
  }
  const seen = new Set();
  const sources = [];
  for (const item of generic ?? []) {
    if (!isRecord(item)) continue;
    const url = text(item.url);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    const chunks = Array.isArray(item.snippets) ? item.snippets.filter((chunk) => typeof chunk === 'string' && chunk.length > 0) : [];
    const entry = isRecord(index) ? index[url] : undefined;
    sources.push(source(url, text(item.title), chunks.length > 0 ? chunks.join('\n\n') : undefined, isRecord(entry) ? publishedAtFromAge(entry.age) : undefined));
  }
  return { sources, truncated: false };
}

/**
 * Map a Web Search response. Results missing a usable URL are skipped; the first
 * occurrence of a URL wins.
 * @param payload - the parsed response body.
 * @returns the normalized result; `sources` may be empty.
 * @throws {WebError} `WEB_PROVIDER_ERROR` when the body is not a recognizable
 *   Web Search envelope.
 */
export function mapWebSearchResponse(payload) {
  if (!isRecord(payload)) {
    throw providerError(`Brave web search response was not a JSON object (received ${describeShape(payload)})`);
  }
  // `web` is the envelope; see the note in `mapLlmContextResponse`. It is present
  // in every successful Web Search response, empty or not.
  if (!('web' in payload)) {
    throw providerError('Brave web search response carried no "web" envelope; this is not a Web Search payload');
  }
  const web = payload.web;
  if (web !== undefined && !isRecord(web)) {
    throw providerError(`Brave web search response carried a "web" field that was not an object (received ${describeShape(web)})`);
  }
  const results = web === undefined ? undefined : web.results;
  if (results !== undefined && !Array.isArray(results)) {
    throw providerError(`Brave web search response carried a "web.results" field that was not an array (received ${describeShape(results)})`);
  }
  const seen = new Set();
  const sources = [];
  for (const item of results ?? []) {
    if (!isRecord(item)) continue;
    const url = text(item.url);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    sources.push(source(url, text(item.title), text(item.description), text(item.page_age)));
  }
  return { sources, truncated: false };
}

/**
 * Map a payload with the mapper belonging to `mode`.
 * @param mode - the resolved mode.
 * @param payload - the parsed response body.
 * @returns the normalized result.
 * @throws {WebError} `WEB_PROVIDER_ERROR` for an unknown mode or an unusable body.
 */
export function mapResponse(mode, payload) {
  if (mode === MODE_LLM_CONTEXT) return mapLlmContextResponse(payload);
  if (mode === MODE_WEB_SEARCH) return mapWebSearchResponse(payload);
  throw providerError(`Brave search mode ${JSON.stringify(String(mode))} is not one of ${MODE_LLM_CONTEXT}, ${MODE_WEB_SEARCH}`);
}

/** The mapper each mode uses, for callers that need the pairing rather than a dispatch. */
export const MAPPER_BY_MODE = Object.freeze({
  [MODE_LLM_CONTEXT]: mapLlmContextResponse,
  [MODE_WEB_SEARCH]: mapWebSearchResponse,
});
