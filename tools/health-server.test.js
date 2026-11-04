"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHealthState, markCycle, markError, startHealthServer } = require("./health-server");

test("health endpoint reports tick state without secrets", async (t) => {
  const state = createHealthState("oracle");
  const server = startHealthServer(state, 0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const before = await (await fetch(`${base}/healthz`)).json();
  assert.equal(before.ok, true);
  assert.equal(before.service, "oracle");
  assert.equal(before.lastCycleAt, null);

  markCycle(state, "posted");
  const after = await (await fetch(`${base}/healthz`)).json();
  assert.equal(after.lastStatus, "posted");
  assert.ok(after.lastCycleAt);

  markError(state);
  const failed = await (await fetch(`${base}/healthz`)).json();
  assert.equal(failed.ok, false);
  assert.equal(failed.lastError, "cycle_failed");

  const missing = await fetch(`${base}/nope`);
  assert.equal(missing.status, 404);
});
