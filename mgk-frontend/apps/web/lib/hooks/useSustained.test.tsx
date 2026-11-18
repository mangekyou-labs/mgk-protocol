import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSustained } from './useSustained';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('turns true only after the condition has held for the whole delay', () => {
  const { result, rerender } = renderHook(({ on }) => useSustained(on, 30_000), { initialProps: { on: true } });
  expect(result.current).toBe(false);
  act(() => { vi.advanceTimersByTime(29_000); });
  expect(result.current).toBe(false);
  act(() => { vi.advanceTimersByTime(1_000); });
  expect(result.current).toBe(true);
  rerender({ on: false });
  expect(result.current).toBe(false);
});

it('restarts the clock when the condition blips off', () => {
  const { result, rerender } = renderHook(({ on }) => useSustained(on, 30_000), { initialProps: { on: true } });
  act(() => { vi.advanceTimersByTime(20_000); });
  rerender({ on: false });
  rerender({ on: true });
  act(() => { vi.advanceTimersByTime(20_000); });
  expect(result.current).toBe(false);
  act(() => { vi.advanceTimersByTime(10_000); });
  expect(result.current).toBe(true);
});
