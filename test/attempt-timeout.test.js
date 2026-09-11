// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Unit cover for {@link attemptTimeout}, the per-attempt deadline used by the
 * transport. The process-level consequence of getting this wrong (an unref'd
 * timer letting Node exit mid-request) is covered in `keepalive.test.js`; this
 * file covers the object's own contract.
 *
 * @module dsh-web-search-brave/test/attempt-timeout
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { attemptTimeout } from '../lib/client.js';

/** Resolve once the signal aborts. */
function aborted(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

test('a fresh deadline has not timed out and carries a live signal', () => {
  const deadline = attemptTimeout(60000);
  try {
    assert.equal(deadline.signal.aborted, false);
    assert.equal(deadline.didTimeOut(), false);
  } finally {
    deadline.dispose();
  }
});

test('the deadline aborts its own signal and reports that it timed out', async () => {
  const deadline = attemptTimeout(15);
  try {
    await aborted(deadline.signal);
    assert.equal(deadline.signal.aborted, true);
    assert.equal(deadline.didTimeOut(), true);
    // The abort reason is deliberately not asserted on: Node normalizes it
    // differently across versions, and nothing in the transport depends on it.
  } finally {
    deadline.dispose();
  }
});

test('a caller-side abort is not reported as our timeout', () => {
  const controller = new AbortController();
  const deadline = attemptTimeout(60000);
  try {
    // The caller's controller is a separate signal; the attempt's own deadline is
    // what `didTimeOut` reports on, so an unrelated abort must not claim a timeout.
    controller.abort();
    assert.equal(deadline.signal.aborted, false);
    assert.equal(deadline.didTimeOut(), false);
  } finally {
    deadline.dispose();
  }
});

test('dispose is idempotent and stops the deadline from aborting', async () => {
  const deadline = attemptTimeout(10);
  deadline.dispose();
  deadline.dispose();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(deadline.signal.aborted, false);
  assert.equal(deadline.didTimeOut(), false);
});

test('each attempt gets an independent deadline', async () => {
  const first = attemptTimeout(10);
  const second = attemptTimeout(60000);
  try {
    await aborted(first.signal);
    assert.equal(first.didTimeOut(), true);
    assert.equal(second.signal.aborted, false);
    assert.equal(second.didTimeOut(), false);
  } finally {
    first.dispose();
    second.dispose();
  }
});
