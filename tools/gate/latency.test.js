'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  LatencyRecorder,
  MIN_ORDERS,
  MIN_SPAN_MS,
  ACCEPTED_P95_MAX_MS,
  SETTLED_P50_MAX_MS,
  SETTLED_MAX_MS,
} = require('./latency');

function record(recorder, { count = 30, acceptMs = 1000, settleMs = 10000, spanMs = 31 * 60 * 1000 } = {}) {
  const start = 1_000_000;
  for (let i = 0; i < count; i++) {
    const id = `order-${i}`;
    const signAt = start + (spanMs * i) / Math.max(1, count);
    recorder.sign(id, signAt, { coldStart: i === 0 });
    recorder.accept(id, signAt + acceptMs);
    const settleAt = i === count - 1 ? start + spanMs : signAt + settleMs;
    // Keep the last settle exactly at the span end without exceeding max.
    if (i === count - 1 && settleAt - signAt > SETTLED_MAX_MS) {
      recorder.settle(id, signAt + settleMs);
    } else {
      recorder.settle(id, settleAt);
    }
  }
  return recorder;
}

test('threshold constants match the gate latency contract', () => {
  assert.equal(MIN_ORDERS, 30);
  assert.equal(MIN_SPAN_MS, 30 * 60 * 1000);
  assert.equal(ACCEPTED_P95_MAX_MS, 5000);
  assert.equal(SETTLED_P50_MAX_MS, 20000);
  assert.equal(SETTLED_MAX_MS, 60000);
});

test('a full healthy run passes: 30 orders, 30+ min span, cold start, within latency budgets', () => {
  const summary = record(new LatencyRecorder()).summary();
  assert.equal(summary.pass, true, JSON.stringify(summary.verdict));
  assert.equal(summary.verdict.pass, true);
  assert.equal(summary.orders, 30);
  assert.equal(summary.accepted.count, 30);
  assert.equal(summary.settled.count, 30);
  assert.ok(summary.spanMs >= MIN_SPAN_MS);
  assert.equal(summary.hasColdStart ?? summary.coldStart, true);
  assert.ok(summary.accepted.p95 <= ACCEPTED_P95_MAX_MS);
  assert.ok(summary.settled.p50 <= SETTLED_P50_MAX_MS);
  assert.ok(summary.settled.max <= SETTLED_MAX_MS);
});

test('nearest-rank percentiles: p50 and p95 come from ranked samples, not averages', () => {
  const r = new LatencyRecorder();
  // accepted latencies 100,200,...,1000 -> nearest-rank p50 = 500, p95 = 1000.
  for (let i = 0; i < 10; i++) {
    const signAt = i * 100000;
    r.sign(`o${i}`, signAt);
    r.accept(`o${i}`, signAt + (i + 1) * 100);
    r.settle(`o${i}`, signAt + (i + 1) * 100);
  }
  const summary = r.summary();
  assert.equal(summary.accepted.p50, 500);
  assert.equal(summary.accepted.p95, 1000);
  assert.equal(summary.accepted.max, 1000);
});

test('signed-but-unsettled orders fail the verdict', () => {
  const r = record(new LatencyRecorder());
  r.sign('late', 9_000_000);
  r.accept('late', 9_000_500);
  const summary = r.summary();
  assert.equal(summary.pass, false);
  assert.ok(summary.unsettled.includes('late'));
  assert.ok(summary.verdict.failures.some(f => /unsettled|late/.test(f)));
});

test('verdict fails without a cold start, with too few orders, and with a short span', () => {
  const noCold = new LatencyRecorder();
  for (let i = 0; i < 30; i++) {
    const signAt = i * 70000;
    noCold.sign(`o${i}`, signAt);
    noCold.accept(`o${i}`, signAt + 100);
    noCold.settle(`o${i}`, signAt + 1000);
  }
  assert.equal(noCold.summary().pass, false);
  assert.ok(noCold.summary().verdict.failures.some(f => /cold/.test(f)));

  const few = record(new LatencyRecorder(), { count: 3 });
  assert.equal(few.summary().pass, false);

  const short = new LatencyRecorder();
  for (let i = 0; i < 30; i++) {
    const signAt = i * 1000;
    short.sign(`o${i}`, signAt, { coldStart: i === 0 });
    short.accept(`o${i}`, signAt + 100);
    short.settle(`o${i}`, signAt + 1000);
  }
  assert.equal(short.summary().pass, false);
  assert.ok(short.summary().verdict.failures.some(f => /span|30 min/.test(f)));
});

test('slow accepted or settled latencies fail the verdict', () => {
  const slowAccept = record(new LatencyRecorder(), { acceptMs: 9000 });
  assert.equal(slowAccept.summary().pass, false);
  const slowSettle = record(new LatencyRecorder(), { settleMs: 30000 });
  assert.equal(slowSettle.summary().pass, false);
});

test('declared-unhealthy samples are excluded from counts and verdict', () => {
  const r = record(new LatencyRecorder());
  r.sign('sick', 9_000_000, { coldStart: false });
  r.exclude('sick', 'declared unhealthy window');
  const summary = r.summary();
  assert.equal(summary.orders, 30);
  assert.equal(summary.excluded.length, 1);
  assert.equal(summary.excluded[0].id, 'sick');
  assert.equal(summary.excluded[0].reason, 'declared unhealthy window');
  assert.equal(summary.pass, true, JSON.stringify(summary.verdict));
});

test('duplicate, unknown and out-of-order timestamps throw', () => {
  const r = new LatencyRecorder();
  r.sign('a', 100);
  assert.throws(() => r.sign('a', 101), /a/);
  assert.throws(() => r.accept('missing', 200), /missing/);
  assert.throws(() => r.settle('a', 50), /a/);
  assert.throws(() => r.exclude('missing', 'x'), /missing/);
  assert.throws(() => r.exclude('a', ''), /reason/);
  const r2 = new LatencyRecorder();
  r2.sign('b', 100);
  r2.accept('b', 300);
  assert.throws(() => r2.settle('b', 200), /b/);
});

test('timestamps default to Date.now when omitted', () => {
  const r = new LatencyRecorder();
  r.sign('now-order', undefined, { coldStart: true });
  r.accept('now-order');
  r.settle('now-order');
  const summary = r.summary();
  assert.equal(summary.accepted.count, 1);
  assert.equal(summary.settled.count, 1);
  assert.ok(summary.accepted.max >= 0);
});
