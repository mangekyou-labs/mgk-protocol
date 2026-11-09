'use client';

import { useSyncExternalStore } from 'react';

/** Bottom panel height as a share of the space it splits with the main area. */
export const PANEL_MIN = 0.15;
export const PANEL_MAX = 0.7;
export const PANEL_DEFAULT = 0.3;

export interface BottomPanelPrefs {
  fraction: number;
  collapsed: boolean;
}

const STORAGE_KEY = 'mgk.trade.bottomPanel';
const DEFAULTS: BottomPanelPrefs = {
  fraction: PANEL_DEFAULT,
  collapsed: false,
};

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: BottomPanelPrefs = DEFAULTS;
// Used when localStorage refuses writes (private mode, full quota).
let unsaved: BottomPanelPrefs | null = null;

export function clampFraction(value: number): number {
  return (
    Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, value)) * 100) / 100
  );
}

function parse(raw: string | null): BottomPanelPrefs {
  if (raw === null) return DEFAULTS;
  try {
    const value = JSON.parse(raw) as Partial<BottomPanelPrefs>;
    return {
      fraction:
        typeof value.fraction === 'number' && Number.isFinite(value.fraction)
          ? clampFraction(value.fraction)
          : PANEL_DEFAULT,
      collapsed: value.collapsed === true,
    };
  } catch {
    return DEFAULTS;
  }
}

function read(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function getSnapshot(): BottomPanelPrefs {
  if (unsaved) return unsaved;
  const raw = read();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function write(next: BottomPanelPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The panel still works, it just won't persist.
    unsaved = next;
  }
  listeners.forEach((listener) => listener());
}

/** Height and collapsed state of the trade page's bottom panel, saved in localStorage. */
export function useBottomPanelPrefs() {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULTS);
  return {
    ...prefs,
    setFraction: (fraction: number) =>
      write({ ...getSnapshot(), fraction: clampFraction(fraction) }),
    setCollapsed: (collapsed: boolean) =>
      write({ ...getSnapshot(), collapsed }),
  };
}
