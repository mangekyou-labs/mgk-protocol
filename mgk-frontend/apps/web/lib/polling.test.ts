import { describe, expect, it } from 'vitest';

import { friendlyRpcError } from './polling';

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
