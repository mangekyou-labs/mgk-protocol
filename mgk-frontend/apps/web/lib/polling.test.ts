import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { friendlyRpcError, pollWhileVisible } from './polling';

describe('friendlyRpcError', () => {
  it.each([
    '429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":429}}',
    'failed to get info about account: Error: 503 Service Unavailable',
    'TypeError: Failed to fetch',
    'fetch failed',
    'Request timed out',
    'connect ECONNREFUSED 127.0.0.1:8899',
  ])('replaces the transport error %j with the busy notice', (raw) => {
    expect(friendlyRpcError(raw)).toBe('Network busy, retrying…');
  });

  it.each([
    'Wrong cluster: connect to devnet. Check your RPC.',
    'Wrong cluster. Select a devnet RPC and reconnect your wallet.',
    'Registry does not match the deployment manifest.',
    'No open collecting batch found. Wait for the keeper to open the next window.',
  ])('passes the actionable error %j through unchanged', (raw) => {
    expect(friendlyRpcError(raw)).toBe(raw);
  });

  it('returns null when there is no error', () => {
    expect(friendlyRpcError(null)).toBeNull();
    expect(friendlyRpcError('')).toBeNull();
  });
});

describe('pollWhileVisible', () => {
  let hidden = false;
  const setHidden = (value: boolean) => {
    hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ticks on the interval while the tab is visible', () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 1000);
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it('skips ticks while the tab is hidden', () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 1000);
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
    stop();
  });

  it('ticks once as soon as the tab becomes visible again', () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 1000);
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    setHidden(false);
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops ticking and listening after cleanup', () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 1000);
    stop();
    vi.advanceTimersByTime(5000);
    setHidden(true);
    setHidden(false);
    expect(tick).not.toHaveBeenCalled();
  });
});
