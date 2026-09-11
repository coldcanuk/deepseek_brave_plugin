// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Response mapping: field mapping for both Brave envelopes, snippet joining,
 * publication-date precedence, URL dedupe, empty results, and the wrong-shaped
 * body that must be an error rather than a silent empty answer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WEB_PROVIDER_ERROR } from '../lib/errors.js';
import { mapLlmContextResponse, mapResponse, mapWebSearchResponse, publishedAtFromAge } from '../lib/map.js';
import { llmContextBody, webSearchBody } from './helpers/mock-brave.js';

/** Assert that a thunk throws a provider error whose message matches `pattern`. */
function throwsProviderError(thunk, pattern) {
  assert.throws(thunk, (error) => {
    assert.equal(error.code, WEB_PROVIDER_ERROR);
    assert.match(error.message, pattern);
    return true;
  });
}

test('llm-context maps url, title, joined snippets, and the published timestamp', () => {
  const result = mapLlmContextResponse(
    llmContextBody({
      generic: [
        { url: 'https://example.test/a', title: 'A', snippets: ['first chunk', 'second chunk'] },
        { url: 'https://example.test/b', title: 'B', snippets: [] },
      ],
      sources: {
        'https://example.test/a': { title: 'A', hostname: 'example.test', age: ['Monday, January 15, 2024', '2024-01-15', '380 days ago', '2024-01-15T13:45:02Z'] },
        'https://example.test/b': { title: 'B', hostname: 'example.test', age: ['Monday, January 15, 2024', '2023-06-01', '380 days ago', 'not a timestamp'] },
      },
    }),
  );
  assert.deepEqual(result, {
    sources: [
      { url: 'https://example.test/a', title: 'A', snippet: 'first chunk\n\nsecond chunk', publishedAt: '2024-01-15T13:45:02Z' },
      { url: 'https://example.test/b', title: 'B', publishedAt: '2023-06-01' },
    ],
    truncated: false,
  });
});

test('publishedAt prefers the ISO timestamp and falls back to the calendar date', () => {
  assert.equal(publishedAtFromAge(['a', '2024-01-15', 'c', '2024-01-15T13:45:02Z']), '2024-01-15T13:45:02Z');
  assert.equal(publishedAtFromAge(['a', '2024-01-15', 'c', 'yesterday']), '2024-01-15');
  assert.equal(publishedAtFromAge(['a', '2024-01-15', 'c']), '2024-01-15');
  assert.equal(publishedAtFromAge(['a', '2024-01-15', 'c', '2024-13-45T99:99:99Z']), '2024-01-15');
  assert.equal(publishedAtFromAge(['a', '2024-13-45', 'c']), undefined);
  assert.equal(publishedAtFromAge(['a', 'not a date', 'c']), undefined);
  assert.equal(publishedAtFromAge(['a']), undefined);
  assert.equal(publishedAtFromAge(undefined), undefined);
  assert.equal(publishedAtFromAge('2024-01-15'), undefined);
});

test('llm-context omits fields Brave did not supply instead of inventing them', () => {
  const result = mapLlmContextResponse(llmContextBody({ generic: [{ url: 'https://example.test/a' }] }));
  assert.deepEqual(result.sources, [{ url: 'https://example.test/a' }]);
});

test('llm-context skips unusable entries and keeps the first occurrence of a URL', () => {
  const result = mapLlmContextResponse(
    llmContextBody({
      generic: [
        { url: 'https://example.test/a', title: 'first' },
        { url: 'https://example.test/a', title: 'second' },
        { title: 'no url' },
        'not an object',
        { url: '', title: 'empty url' },
        { url: 'https://example.test/b', snippets: ['only', 7, '', null] },
      ],
    }),
  );
  assert.deepEqual(result.sources, [
    { url: 'https://example.test/a', title: 'first' },
    { url: 'https://example.test/b', snippet: 'only' },
  ]);
});

test('llm-context treats an empty grounding list as a legitimate empty answer', () => {
  assert.deepEqual(mapLlmContextResponse(llmContextBody()), { sources: [], truncated: false });
  assert.deepEqual(mapLlmContextResponse(llmContextBody({ generic: [] })), { sources: [], truncated: false });
  assert.deepEqual(mapLlmContextResponse({ grounding: {} }), { sources: [], truncated: false });
  assert.deepEqual(mapLlmContextResponse({ sources: {} }), { sources: [], truncated: false });
});

test('llm-context rejects a body that is not an LLM Context payload', () => {
  throwsProviderError(() => mapLlmContextResponse(null), /not a JSON object \(received null\)/u);
  throwsProviderError(() => mapLlmContextResponse('{}'), /not a JSON object \(received a string\)/u);
  throwsProviderError(() => mapLlmContextResponse([]), /not a JSON object \(received an array\)/u);
  throwsProviderError(() => mapLlmContextResponse({ web: { results: [] } }), /neither a "grounding" nor a "sources" envelope/u);
  throwsProviderError(() => mapLlmContextResponse({}), /neither a "grounding" nor a "sources" envelope/u);
});

test('llm-context rejects a recognized envelope with the wrong inner shape', () => {
  throwsProviderError(() => mapLlmContextResponse({ grounding: [] }), /"grounding" field that was not an object/u);
  throwsProviderError(() => mapLlmContextResponse({ grounding: { generic: {} } }), /"grounding.generic" field that was not an array/u);
  throwsProviderError(() => mapLlmContextResponse({ grounding: {}, sources: [] }), /"sources" field that was not an object/u);
});

test('web-search maps url, title, description, and page_age', () => {
  const result = mapWebSearchResponse(
    webSearchBody({
      results: [
        { url: 'https://example.test/a', title: 'A', description: 'plain description', page_age: '2024-01-15' },
        { url: 'https://example.test/b', title: 'B' },
      ],
    }),
  );
  assert.deepEqual(result, {
    sources: [
      { url: 'https://example.test/a', title: 'A', snippet: 'plain description', publishedAt: '2024-01-15' },
      { url: 'https://example.test/b', title: 'B' },
    ],
    truncated: false,
  });
});

test('web-search treats an absent result list as a legitimate empty answer', () => {
  assert.deepEqual(mapWebSearchResponse(webSearchBody()), { sources: [], truncated: false });
  assert.deepEqual(mapWebSearchResponse({ web: {} }), { sources: [], truncated: false });
  assert.deepEqual(mapWebSearchResponse({ query: { original: 'nothing' } }), { sources: [], truncated: false });
});

test('web-search dedupes by URL and skips unusable entries', () => {
  const result = mapWebSearchResponse(
    webSearchBody({
      results: [
        { url: 'https://example.test/a', title: 'first' },
        { url: 'https://example.test/a', title: 'second' },
        { title: 'no url' },
        null,
        { url: 'https://example.test/c', description: '' },
      ],
    }),
  );
  assert.deepEqual(result.sources, [{ url: 'https://example.test/a', title: 'first' }, { url: 'https://example.test/c' }]);
});

test('web-search rejects a body that is not a Web Search payload', () => {
  throwsProviderError(() => mapWebSearchResponse(null), /not a JSON object/u);
  throwsProviderError(() => mapWebSearchResponse({ grounding: { generic: [] } }), /neither a "web" nor a "query" envelope/u);
  throwsProviderError(() => mapWebSearchResponse({}), /neither a "web" nor a "query" envelope/u);
  throwsProviderError(() => mapWebSearchResponse({ web: 'results' }), /"web" field that was not an object/u);
  throwsProviderError(() => mapWebSearchResponse({ web: { results: {} } }), /"web.results" field that was not an array/u);
});

test('mapResponse dispatches on the mode and rejects an unknown one', () => {
  const llm = mapResponse('llm-context', llmContextBody({ generic: [{ url: 'https://example.test/a' }] }));
  assert.equal(llm.sources.length, 1);
  const web = mapResponse('web-search', webSearchBody({ results: [{ url: 'https://example.test/b' }] }));
  assert.equal(web.sources.length, 1);
  throwsProviderError(() => mapResponse('something-else', {}), /not one of llm-context, web-search/u);
});

test('a provider never claims truncation: the seam owns that decision', () => {
  assert.equal(mapLlmContextResponse(llmContextBody({ generic: [{ url: 'https://example.test/a' }] })).truncated, false);
  assert.equal(mapWebSearchResponse(webSearchBody({ results: [{ url: 'https://example.test/a' }] })).truncated, false);
});
