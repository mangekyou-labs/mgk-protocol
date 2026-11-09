'use client';

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  PANEL_MAX,
  PANEL_MIN,
  clampFraction,
  useBottomPanelPrefs,
} from '@/lib/hooks/useBottomPanelPrefs';
import { BottomTabs, type BottomTabsProps } from './BottomTabs';

const KEY_STEP = 0.05;

/**
 * The resizable, collapsible portfolio panel at the bottom of the desktop
 * trade page. Its height is a share of its parent, so the parent must be the
 * region the panel splits with the main area.
 */
export function BottomPanel(
  props: Omit<BottomTabsProps, 'collapsed' | 'onToggleCollapsed'>,
) {
  const prefs = useBottomPanelPrefs();
  const { collapsed, setFraction, setCollapsed } = prefs;
  // While dragging, the height lives here and is saved once on release.
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const fraction = dragFraction ?? prefs.fraction;
  const panelRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);

  function resizeTo(clientY: number) {
    const region = panelRef.current?.parentElement?.getBoundingClientRect();
    if (!region || region.height <= 0) return;
    setDragFraction(clampFraction((region.bottom - clientY) / region.height));
  }
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    dragging.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (dragging.current !== event.pointerId) return;
    resizeTo(event.clientY);
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (dragging.current !== event.pointerId) return;
    dragging.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (dragFraction !== null) setFraction(dragFraction);
    setDragFraction(null);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowUp') setFraction(fraction + KEY_STEP);
    else if (event.key === 'ArrowDown') setFraction(fraction - KEY_STEP);
    else if (event.key === 'Home') setFraction(PANEL_MIN);
    else if (event.key === 'End') setFraction(PANEL_MAX);
    else return;
    event.preventDefault();
  }

  return (
    <div
      ref={panelRef}
      data-testid="bottom-panel"
      style={{
        height: collapsed ? undefined : `${Math.round(fraction * 100)}%`,
      }}
      className="relative flex shrink-0 flex-col border-t border-border"
    >
      {!collapsed && (
        <div
          role="separator"
          aria-label="Resize portfolio panel"
          aria-orientation="horizontal"
          aria-valuemin={PANEL_MIN * 100}
          aria-valuemax={PANEL_MAX * 100}
          aria-valuenow={Math.round(fraction * 100)}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none after:absolute after:inset-x-0 after:top-1 after:h-px after:bg-accent after:opacity-0 after:transition-opacity motion-reduce:after:transition-none hover:after:opacity-100 focus-visible:outline-none focus-visible:after:opacity-100"
        />
      )}
      <BottomTabs
        {...props}
        className="min-h-0 flex-1"
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed(!collapsed)}
      />
    </div>
  );
}
