'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { OrderSide, SidePreset } from './OrderForm';

export interface OrderDrawerProps {
  /** The order form. Stays mounted while the sheet is closed so typed input survives. */
  children: (preset: SidePreset | null) => ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const barButton =
  'cta flex-1 rounded py-2.5 text-sm font-semibold text-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** Phone only: a sticky Buy/Sell bar that opens the order form in a bottom sheet. */
export function OrderDrawer({ children }: OrderDrawerProps) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<SidePreset | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  function openFor(side: OrderSide, trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setPreset((prev) => ({ side, nonce: (prev?.nonce ?? 0) + 1 }));
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    sheetRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
      else if (event.key === 'Tab') trapFocus(event);
    }
    // Wrap Tab at the sheet's edges so focus can't reach the page behind it.
    function trapFocus(event: KeyboardEvent) {
      const focusable = Array.from(
        sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === sheetRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      triggerRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      <div
        data-testid="order-drawer-bar"
        className="flex shrink-0 gap-2 border-t border-border bg-surface-1 p-2"
      >
        <button
          type="button"
          className={`${barButton} bg-bull`}
          onClick={(e) => openFor('buy', e.currentTarget)}
        >
          Buy
        </button>
        <button
          type="button"
          className={`${barButton} bg-bear`}
          onClick={(e) => openFor('sell', e.currentTarget)}
        >
          Sell
        </button>
      </div>
      <div
        data-testid="order-drawer-backdrop"
        data-open={open}
        aria-hidden
        onClick={() => setOpen(false)}
        className={`drawer-backdrop fixed inset-0 z-40 bg-black/60 ${open ? '' : 'pointer-events-none'}`}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Order form"
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
        data-open={open}
        data-testid="order-drawer"
        className="drawer-sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-xl border-t border-border bg-surface-1 focus-visible:outline-none"
      >
        <div className="flex shrink-0 items-center justify-between px-3 pt-2">
          <span aria-hidden className="mx-auto h-1 w-10 rounded-full bg-surface-3" />
          <button
            type="button"
            aria-label="Close order form"
            onClick={() => setOpen(false)}
            className="absolute right-2 top-1.5 px-2 text-lg leading-none text-text-muted hover:text-text"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {children(preset)}
        </div>
      </div>
    </>
  );
}
