import assert from "node:assert/strict";
import { test } from "bun:test";
import { createRequestLifecycle } from "../src/client/request-lifecycle";

test("begin aborts prior work and only the latest request can commit", () => {
  const lifecycle = createRequestLifecycle();
  const older = lifecycle.begin();
  const newer = lifecycle.begin();

  assert.equal(older.signal.aborted, true);
  assert.equal(older.isCurrent(), false);
  assert.equal(newer.signal.aborted, false);
  assert.equal(newer.isCurrent(), true);

  lifecycle.dispose();
  assert.equal(newer.signal.aborted, true);
  assert.equal(newer.isCurrent(), false);
});

test("invalidation aborts current work at an authentication boundary", () => {
  const lifecycle = createRequestLifecycle();
  const request = lifecycle.begin();

  lifecycle.invalidate();

  assert.equal(request.signal.aborted, true);
  assert.equal(request.isCurrent(), false);
});
