'use client';

import { useSyncExternalStore } from 'react';

export type LayoutMode = 'desktop' | 'tablet' | 'phone';

// Tailwind's md (768px) and xl (1280px) breakpoints.
const PHONE_QUERY = '(max-width: 767.98px)';
const TABLET_QUERY = '(max-width: 1279.98px)';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

function getSnapshot(): LayoutMode {
  if (matches(PHONE_QUERY)) return 'phone';
  if (matches(TABLET_QUERY)) return 'tablet';
  return 'desktop';
}

function subscribe(onChange: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const lists = [PHONE_QUERY, TABLET_QUERY].map((q) => window.matchMedia(q));
  lists.forEach((list) => list.addEventListener('change', onChange));
  return () => lists.forEach((list) => list.removeEventListener('change', onChange));
}

/**
 * Which trade layout fits the viewport. Null on the server and during
 * hydration, so no layout mounts (and starts loading) before the real one.
 */
export function useLayoutMode(): LayoutMode | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
