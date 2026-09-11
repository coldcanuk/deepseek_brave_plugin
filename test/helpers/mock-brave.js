// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * A local `node:http` server standing in for the Brave Search API.
 *
 * Tests point the provider's `baseURL` at {@link MockBrave.baseURL}, so the suite
 * needs no external network and no API key. Responses are scripted: each
 * incoming request consumes the next queued step and falls back to the default
 * response once the script is exhausted, which lets a test express
 * "429, then 200" as two queued steps.
 *
 * @module dsh-web-search-brave/test/helpers/mock-brave
 */
import http from 'node:http';

/** Path the LLM Context endpoint answers on. */
export const MOCK_LLM_CONTEXT_PATH = '/res/v1/llm/context';
/** Path the Web Search endpoint answers on. */
export const MOCK_WEB_SEARCH_PATH = '/res/v1/web/search';

/** One scripted response. */
export class MockBrave {
  /** The listening server, once started. */
  #server;
  /** Queued steps, consumed in order. */
  #script = [];
  /** Response used once the script is exhausted. */
  #fallback;
  /** Every request the server received, in arrival order. */
  requests = [];
  /** The ephemeral port actually bound. */
  port = 0;

  /**
   * @param options - optional `fallback` response step for unscripted requests.
   */
  constructor(options = {}) {
    this.#fallback = { status: 200, body: {}, ...options.fallback };
  }

  /** Bind an ephemeral port on the loopback interface. */
  async start() {
    const server = http.createServer((request, response) => {
      this.#respond(request, response);
    });
    server.on('clientError', () => {});
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.#server = server;
    this.port = server.address().port;
    return this;
  }

  /** Origin of the running server, without the API path. */
  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Base URL to hand the provider: the origin plus Brave's `/res/v1` root. */
  get baseURL() {
    return `${this.origin}/res/v1`;
  }

  /** Queue one raw scripted step. */
  enqueue(step) {
    this.#script.push(step);
    return this;
  }

  /** Queue a JSON response with the given status. */
  reply(status, body, options = {}) {
    return this.enqueue({ status, body, ...options });
  }

  /** Queue a successful JSON response. */
  json(body, options = {}) {
    return this.reply(200, body, options);
  }

  /** Queue a response whose body is not JSON at all. */
  raw(text, options = {}) {
    return this.enqueue({ status: 200, body: text, raw: true, ...options });
  }

  /** Queue a response that never arrives, so the client must time out. */
  hang() {
    return this.enqueue({ hang: true });
  }

  /** Queue a dropped connection. */
  drop() {
    return this.enqueue({ drop: true });
  }

  /** The request paths received so far. */
  get paths() {
    return this.requests.map((request) => request.path);
  }

  /** Stop the server, dropping any connection a hung request left open. */
  async close() {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    server.closeAllConnections?.();
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    server.closeAllConnections?.();
  }

  /** Record the request, then answer it with the next scripted step. */
  #respond(request, response) {
    request.on('error', () => {});
    response.on('error', () => {});
    const url = new URL(request.url, this.origin);
    this.requests.push({
      method: request.method,
      path: url.pathname,
      url: request.url,
      headers: request.headers,
      params: Object.fromEntries(url.searchParams),
    });
    const step = this.#script.shift() ?? this.#fallback;
    if (step.hang === true) return;
    const send = () => {
      if (step.drop === true) {
        response.destroy();
        return;
      }
      const payload = step.raw === true ? String(step.body ?? '') : JSON.stringify(step.body ?? {});
      response.writeHead(step.status ?? 200, {
        'content-type': step.raw === true ? 'text/plain' : 'application/json',
        ...(step.headers ?? {}),
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    };
    if (typeof step.delayMs === 'number' && step.delayMs > 0) setTimeout(send, step.delayMs);
    else send();
  }
}

/**
 * Start a mock server.
 * @param options - see {@link MockBrave}.
 * @returns the started server.
 */
export async function startMockBrave(options) {
  return await new MockBrave(options).start();
}

/** Build an LLM Context body from grounding entries and a sources index. */
export function llmContextBody({ generic = [], sources = {} } = {}) {
  return { grounding: { generic }, sources };
}

/** Build a Web Search body from result entries. */
export function webSearchBody({ results = [] } = {}) {
  return { web: { type: 'search', results } };
}
