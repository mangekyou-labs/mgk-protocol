'use client';

import { useEffect, useState } from 'react';
import { config } from '@/lib/config';
import { FAILURE_THRESHOLD } from '@/lib/polling';
import { TRADE_POLL_INTERVAL_MS } from '@/lib/protocol';
export interface StatusCheck {
  severity: 'ok' | 'warn' | 'critical';
  available?: boolean;
  reachable?: boolean;
  flags?: number;
  syncing?: boolean;
  lagSlots?: number;
  ageSeconds?: number;
  phase?: number;
}
export interface ProtocolStatus {
  severity: 'ok' | 'warn' | 'critical';
  checks: Record<string, StatusCheck>;
}
export interface ProtocolStatusReading {
  data: ProtocolStatus | null;
  loading: boolean;
  error: string | null;
}

/**
 * One page-level request supplies both banners and status bar. A single failed
 * or slow read keeps the last status; persistent failures clear health.
 */
export function useProtocolStatus(): ProtocolStatusReading {
  const [reading, setReading] = useState<ProtocolStatusReading>({
    data: null,
    loading: true,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    let active = false;
    let failures = 0;
    const tick = async () => {
      if (active) return;
      active = true;
      const mine = new AbortController();
      controller = mine;
      let settled = false;
      const fail = () => {
        if (settled || cancelled) return;
        settled = true;
        failures++;
        if (failures < FAILURE_THRESHOLD) return;
        setReading({
          data: null,
          loading: false,
          error: 'System status unavailable',
        });
      };
      const timer = setTimeout(() => {
        // A hung request counts as a failure and frees the next tick.
        mine.abort();
        fail();
        active = false;
      }, 4000);
      try {
        const response = await fetch(`${config.indexerUrl}/api/status`, {
          cache: 'no-store',
          signal: mine.signal,
        });
        if (!response.ok) throw new Error('Status endpoint unavailable');
        const data: ProtocolStatus = await response.json();
        if (
          !data ||
          !['ok', 'warn', 'critical'].includes(data.severity) ||
          !data.checks ||
          typeof data.checks !== 'object' ||
          Array.isArray(data.checks) ||
          Object.values(data.checks).some(
            (check) =>
              !check || !['ok', 'warn', 'critical'].includes(check.severity),
          )
        )
          throw new Error('Status response unavailable');
        if (!cancelled && !settled) {
          settled = true;
          failures = 0;
          setReading({ data, loading: false, error: null });
        }
      } catch {
        fail();
      } finally {
        clearTimeout(timer);
        // A late-settling request must not free a newer one's slot.
        if (controller === mine) active = false;
      }
    };
    void tick();
    const handle = setInterval(() => void tick(), TRADE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
      controller?.abort();
    };
  }, []);
  return reading;
}

/** A complete positive signal is required before presenting history as live. */
export function indexerState(
  status: ProtocolStatusReading,
): 'live' | 'syncing' | 'down' | 'unavailable' {
  const check = status.data?.checks.indexer;
  if (!status.data || check?.available === false) return 'down';
  if (!check || typeof check.syncing !== 'boolean') return 'unavailable';
  return check.syncing || check.severity !== 'ok' ? 'syncing' : 'live';
}
