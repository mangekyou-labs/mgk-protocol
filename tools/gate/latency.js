'use strict';
// Latency recorder for gate row P0-33 (issues #35/#11). Callers record
// explicit millisecond timestamps; every `at` argument defaults to
// Date.now() so live drivers can omit it while tests stay deterministic.
//
// Gate context (issue #11): only taker orders against the protocol-maker
// ladder with monitoring green count. sign() therefore requires
// { role: 'taker' } — any other role is an error — and the summary verdict
// fails unless setRunContext (or the constructor options) records
// againstMakerLadder and monitoringGreen as true.
//
// Percentiles use the nearest-rank method: sort the samples ascending and
// take the value at rank ceil(p / 100 * n) (1-based). This is the gate
// contract — a p95 is an observed sample, never an interpolated average.
//
// Samples from declared-unhealthy periods are removed with exclude(id,
// reason, evidence): the evidence must prove the order showed
// "awaiting settlement" with no error and no fake fill, exclusion after
// settlement is refused, and excluded samples leave every count,
// percentile and the span.
const assert = require('node:assert/strict');

const MIN_ORDERS = 30;
const MIN_SPAN_MS = 30 * 60 * 1000;
const ACCEPTED_P95_MAX_MS = 5000;
const SETTLED_P50_MAX_MS = 20000;
const SETTLED_MAX_MS = 60000;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

class LatencyRecorder {
  constructor(now = Date.now, runContext = {}) {
    assert.equal(typeof now, 'function', 'clock function required');
    this._now = now;
    this._orders = new Map();
    this._runContext = { againstMakerLadder: false, monitoringGreen: false };
    this.setRunContext(runContext);
  }

  // Record the gate run context. Both flags must be true for the verdict
  // to pass: the orders ran against the protocol-maker ladder and the
  // monitoring stayed green for the whole run.
  setRunContext({ againstMakerLadder, monitoringGreen } = {}) {
    if (againstMakerLadder !== undefined) this._runContext.againstMakerLadder = Boolean(againstMakerLadder);
    if (monitoringGreen !== undefined) this._runContext.monitoringGreen = Boolean(monitoringGreen);
    return this;
  }

  _at(at) {
    const value = at === undefined ? this._now() : at;
    assert.ok(Number.isFinite(value), 'timestamp (ms) must be a finite number');
    return value;
  }

  _order(id) {
    const order = this._orders.get(id);
    assert.ok(order, `${id}: unknown order`);
    return order;
  }

  sign(id, at, { coldStart = false, role } = {}) {
    assert.ok(typeof id === 'string' && id, 'order id required');
    assert.ok(role === 'taker', `${id}: only taker orders count (role must be 'taker', got ${role ?? 'none'})`);
    assert.ok(!this._orders.has(id), `${id}: already signed`);
    this._orders.set(id, {
      id,
      signAt: this._at(at),
      coldStart: Boolean(coldStart),
      acceptAt: null,
      settleAt: null,
      excluded: null,
    });
    return this;
  }

  accept(id, at) {
    const order = this._order(id);
    assert.ok(!order.excluded, `${id}: order is excluded`);
    assert.equal(order.acceptAt, null, `${id}: already accepted`);
    const value = this._at(at);
    assert.ok(value >= order.signAt, `${id}: accepted before signing`);
    order.acceptAt = value;
    return this;
  }

  settle(id, at) {
    const order = this._order(id);
    assert.ok(!order.excluded, `${id}: order is excluded`);
    assert.ok(order.acceptAt !== null, `${id}: settled before acceptance`);
    assert.equal(order.settleAt, null, `${id}: already settled`);
    const value = this._at(at);
    assert.ok(value >= order.signAt, `${id}: settled before signing`);
    assert.ok(value >= order.acceptAt, `${id}: settled before acceptance`);
    order.settleAt = value;
    return this;
  }

  // Declared-unhealthy sample: kept for the record, removed from the gate.
  // The evidence must prove the order showed "awaiting settlement" with no
  // error and no fake fill, and a settled order can never be excluded, so
  // a slow healthy fill can never be erased from max/percentiles.
  exclude(id, reason, evidence) {
    assert.ok(typeof reason === 'string' && reason.trim(), 'exclude reason required');
    const order = this._order(id);
    assert.ok(!order.excluded, `${id}: already excluded`);
    assert.ok(order.settleAt === null, `${id}: cannot exclude after settlement`);
    assert.ok(
      evidence && evidence.displayed === 'awaiting-settlement' &&
        evidence.errorShown === false && evidence.fakeFillShown === false,
      `${id}: exclusion requires proof the order showed awaiting settlement with no error and no fake fill`,
    );
    order.excluded = {
      reason,
      evidence: {
        displayed: evidence.displayed,
        errorShown: evidence.errorShown,
        fakeFillShown: evidence.fakeFillShown,
      },
    };
    return this;
  }

  summary() {
    const all = [...this._orders.values()];
    const excluded = all.filter(o => o.excluded)
      .map(o => ({ id: o.id, reason: o.excluded.reason, evidence: o.excluded.evidence }));
    const included = all.filter(o => !o.excluded);
    const acceptedSamples = included.filter(o => o.acceptAt !== null).map(o => o.acceptAt - o.signAt);
    const settledSamples = included.filter(o => o.settleAt !== null).map(o => o.settleAt - o.signAt);
    const accepted = stats(acceptedSamples);
    const settled = stats(settledSamples);
    const unsettled = included.filter(o => o.settleAt === null).map(o => o.id);
    const unaccepted = included.filter(o => o.acceptAt === null).map(o => o.id);
    // The cold-start requirement is met by any included order flagged
    // coldStart. drows.js flags only the order placed right after its
    // operator-supplied restart command exited 0, so the flag marks a real
    // cold start wherever it falls in the run, never a label on order one.
    const coldStart = included.some(o => o.coldStart);
    const firstSign = included.length ? Math.min(...included.map(o => o.signAt)) : null;
    const lastSettle = included.some(o => o.settleAt !== null)
      ? Math.max(...included.filter(o => o.settleAt !== null).map(o => o.settleAt))
      : null;
    const spanMs = firstSign !== null && lastSettle !== null ? lastSettle - firstSign : 0;

    const failures = [];
    if (!this._runContext.againstMakerLadder) failures.push('not run against the protocol-maker ladder');
    if (!this._runContext.monitoringGreen) failures.push('monitoring not green');
    if (included.length < MIN_ORDERS) failures.push(`fewer than ${MIN_ORDERS} orders (${included.length})`);
    if (spanMs < MIN_SPAN_MS) failures.push(`span ${spanMs} ms below 30 min (${MIN_SPAN_MS} ms)`);
    if (!coldStart) failures.push('no cold-start order included');
    if (unaccepted.length) failures.push(`signed but never accepted: ${unaccepted.join(', ')}`);
    if (unsettled.length) failures.push(`signed but unsettled: ${unsettled.join(', ')}`);
    if (accepted.p95 !== null && accepted.p95 > ACCEPTED_P95_MAX_MS) {
      failures.push(`accepted p95 ${accepted.p95} ms exceeds ${ACCEPTED_P95_MAX_MS} ms`);
    }
    if (settled.p50 !== null && settled.p50 > SETTLED_P50_MAX_MS) {
      failures.push(`settled p50 ${settled.p50} ms exceeds ${SETTLED_P50_MAX_MS} ms`);
    }
    if (settled.max !== null && settled.max > SETTLED_MAX_MS) {
      failures.push(`settled max ${settled.max} ms exceeds ${SETTLED_MAX_MS} ms`);
    }
    const pass = failures.length === 0;
    return {
      orders: included.length,
      signed: all.length,
      acceptedCount: accepted.count,
      settledCount: settled.count,
      accepted,
      settled,
      spanMs,
      coldStart,
      unsettled,
      excluded,
      runContext: { ...this._runContext },
      verdict: { pass, failures },
    };
  }
}

module.exports = {
  LatencyRecorder,
  MIN_ORDERS,
  MIN_SPAN_MS,
  ACCEPTED_P95_MAX_MS,
  SETTLED_P50_MAX_MS,
  SETTLED_MAX_MS,
  percentile,
};
